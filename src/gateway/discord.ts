import { basename } from "node:path";
import { readFileSync, statSync } from "node:fs";
import pino from "pino";
import {
  DISCORD_ALLOWED_USER_IDS,
  DISCORD_REQUIRE_MENTION,
  isAllowedDiscordUser,
} from "./config.js";
import { discordConversationId, parseDiscordConversationId } from "./conversation-id.js";
import { buildDiscordInboundContext } from "./discord-inbound.js";
import type { IncomingMessage } from "./incoming-message.js";
import {
  normalizeAttachmentPaths,
  splitMessage,
  type OutboundMessage,
} from "./messages.js";
import { ProgressController, type ProgressTransport } from "./progress.js";
import { DiscordRestClient } from "./discord-rest.js";

const log = pino({ name: "discord" });
const GATEWAY_VERSION = 10;
const DISCORD_MAX_LENGTH = 2000;
const TYPING_INTERVAL_MS = 8000;
const MAX_ATTACHMENTS = 10;

export type DiscordMessageHandler = (message: IncomingMessage) => Promise<void>;

export interface DiscordConnection {
  ready: Promise<void>;
  sendMessage: (conversationId: string, payload: OutboundMessage) => Promise<void>;
  sendTyping: (conversationId: string) => Promise<void>;
  stop: () => void;
}

export function connectDiscord(
  token: string,
  onMessage: DiscordMessageHandler,
): DiscordConnection {
  const rest = new DiscordRestClient(token);
  let readyResolve = () => {};
  let readyReject = (_err: unknown) => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  let ws: WebSocket | null = null;
  let seq: number | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let botUserId = "";
  let readySettled = false;

  const settleReady = (fn: () => void) => {
    if (readySettled) return;
    readySettled = true;
    fn();
  };

  const api = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => rest.request(path, init);

  const sendGateway = (payload: Record<string, unknown>) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  };

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const heartbeat = () => {
    sendGateway({ op: 1, d: seq });
  };

  const identify = () => {
    sendGateway({
      op: 2,
      d: {
        token,
        intents:
          (1 << 9) | // GUILD_MESSAGES
          (1 << 12) | // DIRECT_MESSAGES
          (1 << 15), // MESSAGE_CONTENT
        properties: {
          os: process.platform,
          browser: "donna",
          device: "donna",
        },
      },
    });
  };

  const reconnect = async (delayMs = 3000) => {
    if (stopped) return;
    clearHeartbeat();
    if (ws) {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("message", onWsMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
      ws = null;
    }
    setTimeout(() => {
      void connect();
    }, delayMs);
  };

  const onOpen = () => {
    log.info("Discord gateway socket opened");
  };

  const onClose = (event: CloseEvent) => {
    log.warn({ code: event.code, reason: event.reason }, "Discord gateway closed");
    void reconnect();
  };

  const onError = (event: Event) => {
    log.error({ eventType: event.type }, "Discord gateway error");
  };

  const onWsMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;

    let payload: any;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (typeof payload.s === "number") {
      seq = payload.s;
    }

    switch (payload.op) {
      case 10: {
        const intervalMs = Number(payload.d?.heartbeat_interval) || 45_000;
        clearHeartbeat();
        heartbeat();
        heartbeatTimer = setInterval(heartbeat, intervalMs);
        identify();
        return;
      }
      case 7:
        void reconnect(1000);
        return;
      case 9:
        void reconnect(1000);
        return;
      default:
        break;
    }

    if (payload.t === "READY") {
      botUserId = String(payload.d?.user?.id || "");
      log.info({ botUserId }, "Discord gateway ready");
      settleReady(readyResolve);
      return;
    }

    if (payload.t === "MESSAGE_CREATE") {
      void handleIncomingMessage(payload.d, onMessage, () => botUserId, api);
    }
  };

  const connect = async () => {
    try {
      const response = await api("/gateway/bot");
      if (!response.ok) {
        throw new Error(`Discord gateway lookup failed (${response.status})`);
      }

      const data = await response.json() as { url?: string };
      if (!data.url) {
        throw new Error("Discord gateway URL missing");
      }

      ws = new WebSocket(`${data.url}/?v=${GATEWAY_VERSION}&encoding=json`);
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onWsMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    } catch (err) {
      log.error({ err }, "Failed to connect to Discord gateway");
      settleReady(() => readyReject(err));
      void reconnect(5000);
    }
  };

  void connect();

  async function sendTyping(conversationId: string): Promise<void> {
    const channelId = parseDiscordConversationId(conversationId);
    const response = await api(`/channels/${channelId}/typing`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Discord typing failed (${response.status})`);
    }
  }

  async function sendMessage(conversationId: string, payload: OutboundMessage): Promise<void> {
    const channelId = parseDiscordConversationId(conversationId);
    const textChunks = splitMessage(payload.text || "", DISCORD_MAX_LENGTH);
    const attachmentPaths = normalizeAttachmentPaths(payload.attachments || []).slice(0, MAX_ATTACHMENTS);

    if (textChunks.length === 0 && attachmentPaths.length === 0) {
      return;
    }

    if (textChunks.length === 0 && attachmentPaths.length > 0) {
      await postDiscordMessage(api, channelId, undefined, attachmentPaths);
      return;
    }

    const [firstChunk, ...remainingChunks] = textChunks;
    await postDiscordMessage(api, channelId, firstChunk, attachmentPaths);

    for (const chunk of remainingChunks) {
      await postDiscordMessage(api, channelId, chunk, []);
    }
  }

  function stop() {
    stopped = true;
    clearHeartbeat();
    if (ws) {
      ws.close(1000, "shutdown");
      ws = null;
    }
  }

  return {
    ready,
    sendMessage,
    sendTyping,
    stop,
  };
}

async function handleIncomingMessage(
  message: any,
  onMessage: DiscordMessageHandler,
  getBotUserId: () => string,
  api: (path: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  const authorId = String(message?.author?.id || "");
  const channelId = String(message?.channel_id || "");
  const content = typeof message?.content === "string" ? message.content : "";
  const botUserId = getBotUserId();
  const isDm = !message?.guild_id;

  if (!authorId || !channelId) return;
  if (message?.author?.bot) return;
  if (!isAllowedDiscordUser(authorId)) {
    log.debug({ authorId, allowedCount: DISCORD_ALLOWED_USER_IDS.size }, "Ignoring Discord message from non-allowlisted user");
    return;
  }

  const conversationId = discordConversationId(channelId);
  const inbound = await buildDiscordInboundContext({
    message,
    conversationId,
    api,
  });
  const mentioned = Array.isArray(message?.mentions)
    ? message.mentions.some((entry: any) => String(entry?.id || "") === botUserId)
    : false;
  const repliedToBot = inbound.replyTo?.authorId === botUserId;

  if (!isDm && DISCORD_REQUIRE_MENTION && !mentioned && !repliedToBot) {
    return;
  }

  const cleaned = isDm ? content.trim() : stripBotMentions(content, botUserId);
  if (!cleaned && inbound.attachments.length === 0 && !inbound.replyTo) return;

  const progress = createDiscordProgress(api, channelId, String(message?.id || ""));
  log.info(
    {
      channelId,
      authorId,
      guildId: message?.guild_id || null,
      isDm,
      text: cleaned.slice(0, 80),
      attachmentCount: inbound.attachments.length,
      replyMessageId: inbound.replyTo?.messageId || null,
    },
    "Incoming Discord message",
  );

  try {
    await progress.start();
    await onMessage({
      conversationId,
      text: cleaned,
      attachments: inbound.attachments,
      replyTo: inbound.replyTo,
      progress,
    });
  } catch (err) {
    await progress.fail("Hit a problem.");
    await progress.dispose();
    throw err;
  }
}

function stripBotMentions(content: string, botUserId: string): string {
  if (!botUserId) return content.trim();
  return content
    .replace(new RegExp(`<@!?${escapeRegex(botUserId)}>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function postDiscordMessage(
  api: (path: string, init?: RequestInit) => Promise<Response>,
  channelId: string,
  text: string | undefined,
  attachmentPaths: string[],
): Promise<{ id: string }> {
  const payload = {
    content: text,
    allowed_mentions: { parse: [] as string[] },
  };

  let response: Response;
  if (attachmentPaths.length === 0) {
    response = await api(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } else {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));

    attachmentPaths.forEach((filePath, idx) => {
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        throw new Error(`Attachment is not a file: ${filePath}`);
      }
      const file = new File([readFileSync(filePath)], basename(filePath));
      form.append(`files[${idx}]`, file);
    });

    response = await api(`/channels/${channelId}/messages`, {
      method: "POST",
      body: form,
    });
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord send failed (${response.status}): ${body}`);
  }

  const responseBody = await response.json() as { id?: string };
  return { id: typeof responseBody.id === "string" ? responseBody.id : "" };
}

function createDiscordProgress(
  api: (path: string, init?: RequestInit) => Promise<Response>,
  channelId: string,
  sourceMessageId: string,
): ProgressController {
  let typingTimer: ReturnType<typeof setInterval> | null = null;

  const typingPulse = async () => {
    const response = await api(`/channels/${channelId}/typing`, { method: "POST" });
    if (!response.ok) {
      throw new Error(`Discord typing failed (${response.status})`);
    }
  };

  const transport: ProgressTransport = {
    addReaction: async (emoji: string) => {
      if (!sourceMessageId) return;
      const response = await api(
        `/channels/${channelId}/messages/${sourceMessageId}/reactions/${encodeURIComponent(emoji)}/@me`,
        { method: "PUT" },
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Discord reaction failed (${response.status}): ${body}`);
      }
    },
    removeReaction: async (emoji: string) => {
      if (!sourceMessageId) return;
      const response = await api(
        `/channels/${channelId}/messages/${sourceMessageId}/reactions/${encodeURIComponent(emoji)}/@me`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 404) {
        const body = await response.text();
        throw new Error(`Discord reaction removal failed (${response.status}): ${body}`);
      }
    },
    sendStatusMessage: async (text: string) => {
      const sent = await postDiscordMessage(api, channelId, text, []);
      return sent.id;
    },
    editMessage: async (messageId: string, text: string) => {
      const response = await api(`/channels/${channelId}/messages/${messageId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: text,
          allowed_mentions: { parse: [] as string[] },
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Discord edit failed (${response.status}): ${body}`);
      }
    },
    deleteMessage: async (messageId: string) => {
      const response = await api(`/channels/${channelId}/messages/${messageId}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) {
        const body = await response.text();
        throw new Error(`Discord delete failed (${response.status}): ${body}`);
      }
    },
    beginTyping: async () => {
      if (typingTimer) return;
      await typingPulse();
      typingTimer = setInterval(() => {
        void typingPulse().catch(() => {});
      }, TYPING_INTERVAL_MS);
    },
    endTyping: async () => {
      if (!typingTimer) return;
      clearInterval(typingTimer);
      typingTimer = null;
    },
  };

  return new ProgressController(transport);
}
