import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discordConversationId,
  parseDiscordConversationId,
  parseTelegramConversationId,
  parseWhatsAppConversationId,
  telegramConversationId,
  whatsappConversationId,
} from "../src/gateway/conversation-id.js";
import { buildDiscordInboundContext } from "../src/gateway/discord-inbound.js";
import { EventQueue } from "../src/gateway/event-queue.js";
import { formatIncomingMessageForAgent } from "../src/gateway/incoming-message.js";
import { buildLocalModelSystemPrompt } from "../src/gateway/local-model-rpc.js";
import { parseOutboundMessage } from "../src/gateway/messages.js";
import { buildPiAppendSystemPrompt } from "../src/gateway/pi-rpc.js";
import { createRouter } from "../src/gateway/router.js";
import { buildCodexPrompt } from "../src/gateway/codex-rpc.js";

let tmpAttachmentDir = "";

afterEach(() => {
  vi.unstubAllGlobals();
  if (tmpAttachmentDir) {
    rmSync(tmpAttachmentDir, { recursive: true, force: true });
    tmpAttachmentDir = "";
  }
});

describe("conversation IDs", () => {
  it("round-trips WhatsApp conversation IDs", () => {
    const id = whatsappConversationId("123@s.whatsapp.net");
    expect(parseWhatsAppConversationId(id)).toBe("123@s.whatsapp.net");
  });

  it("round-trips Telegram conversation IDs", () => {
    const id = telegramConversationId("123456");
    expect(parseTelegramConversationId(id)).toBe("123456");
  });

  it("round-trips Discord conversation IDs", () => {
    const id = discordConversationId("987654321");
    expect(parseDiscordConversationId(id)).toBe("987654321");
  });
});

describe("outbound message parsing", () => {
  it("extracts attachment directives from agent text", () => {
    const parsed = parseOutboundMessage([
      "here you go",
      "",
      "[[attachment:/tmp/report.txt]]",
      "[[attachment:/tmp/chart.png]]",
    ].join("\n"));

    expect(parsed.text).toBe("here you go");
    expect(parsed.attachments).toEqual([
      "/tmp/report.txt",
      "/tmp/chart.png",
    ]);
  });

  it("keeps regular text untouched when there are no directives", () => {
    expect(parseOutboundMessage("plain reply")).toEqual({
      text: "plain reply",
      attachments: [],
    });
  });
});

describe("incoming message formatting", () => {
  it("keeps normal messages unchanged when there is no structured context", () => {
    expect(formatIncomingMessageForAgent({
      conversationId: "discord:123",
      text: "plain reply",
    })).toBe("plain reply");
  });

  it("includes structured attachment errors without dropping the user text", () => {
    const formatted = formatIncomingMessageForAgent({
      conversationId: "discord:123",
      text: "please read this",
      attachments: [
        {
          filename: "ESTEBAN.md",
          status: "error",
          error: {
            code: "download_failed",
            message: "Discord attachment download failed (404)",
            status: 404,
          },
        },
      ],
    });

    expect(formatted).toContain("User message text:\nplease read this");
    expect(formatted).toContain("\"attachments\"");
    expect(formatted).toContain("\"code\": \"download_failed\"");
  });
});

describe("soul prompt loading", () => {
  it("injects SOUL.md content into the Codex, Pi, and local prompts", () => {
    const soulDir = mkdtempSync(join(tmpdir(), "donna-soul-"));
    writeFileSync(join(soulDir, "SOUL.md"), "# soul\n\nyou already know.\n");

    const codexPrompt = buildCodexPrompt("hello", [], [], soulDir);
    const localPrompt = buildLocalModelSystemPrompt("local", [], soulDir);
    const piPrompt = buildPiAppendSystemPrompt(soulDir);

    expect(codexPrompt).toContain("you already know.");
    expect(localPrompt).toContain("you already know.");
    expect(piPrompt).toContain("you already know.");

    rmSync(soulDir, { recursive: true, force: true });
  });

  it("omits soul injection when SOUL.md is missing", () => {
    const soulDir = mkdtempSync(join(tmpdir(), "donna-soul-missing-"));

    expect(buildCodexPrompt("hello", [], [], soulDir)).not.toContain("SOUL.md");
    expect(buildLocalModelSystemPrompt("local", [], soulDir)).not.toContain("SOUL.md");
    expect(buildPiAppendSystemPrompt(soulDir)).not.toContain("SOUL.md");

    rmSync(soulDir, { recursive: true, force: true });
  });
});

describe("discord inbound context", () => {
  it("downloads a markdown attachment to a readable local file", async () => {
    tmpAttachmentDir = mkdtempSync(join(tmpdir(), "donna-discord-"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("https://cdn.example/ESTEBAN.md");
      return new Response("# esteban\n", { status: 200 });
    }));

    const inbound = await buildDiscordInboundContext({
      conversationId: discordConversationId("chan-1"),
      attachmentRootDir: tmpAttachmentDir,
      api: async () => new Response(null, { status: 404 }),
      message: {
        id: "msg-1",
        attachments: [
          {
            id: "att-1",
            filename: "ESTEBAN.md",
            content_type: "text/markdown",
            size: 10,
            url: "https://cdn.example/ESTEBAN.md",
          },
        ],
      },
    });

    expect(inbound.attachments).toHaveLength(1);
    expect(inbound.attachments[0]).toMatchObject({
      filename: "ESTEBAN.md",
      mimeType: "text/markdown",
      size: 10,
      status: "ready",
    });
    expect(inbound.attachments[0].path).toBeTruthy();
    expect(existsSync(inbound.attachments[0].path!)).toBe(true);
    expect(readFileSync(inbound.attachments[0].path!, "utf-8")).toBe("# esteban\n");
  });

  it("downloads image attachments and includes reply metadata", async () => {
    tmpAttachmentDir = mkdtempSync(join(tmpdir(), "donna-discord-"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://cdn.example/photo.png") {
        return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
      }
      if (url === "https://cdn.example/original.pdf") {
        return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }));

    const inbound = await buildDiscordInboundContext({
      conversationId: discordConversationId("chan-2"),
      attachmentRootDir: tmpAttachmentDir,
      api: async () => new Response(null, { status: 404 }),
      message: {
        id: "msg-2",
        channel_id: "chan-2",
        guild_id: "guild-1",
        attachments: [
          {
            id: "att-2",
            filename: "photo.png",
            content_type: "image/png",
            size: 4,
            url: "https://cdn.example/photo.png",
          },
        ],
        message_reference: {
          message_id: "reply-1",
          channel_id: "chan-2",
          guild_id: "guild-1",
        },
        referenced_message: {
          id: "reply-1",
          content: "can you read this if i reply to you",
          timestamp: "2026-03-18T12:34:56Z",
          author: {
            id: "user-7",
            username: "Esteban",
          },
          attachments: [
            {
              id: "att-3",
              filename: "original.pdf",
              content_type: "application/pdf",
              size: 4,
              url: "https://cdn.example/original.pdf",
            },
          ],
        },
      },
    });

    expect(inbound.attachments[0]).toMatchObject({
      filename: "photo.png",
      mimeType: "image/png",
      status: "ready",
    });
    expect(existsSync(inbound.attachments[0].path!)).toBe(true);

    expect(inbound.replyTo).toMatchObject({
      messageId: "reply-1",
      author: "Esteban",
      authorId: "user-7",
      text: "can you read this if i reply to you",
      timestamp: "2026-03-18T12:34:56Z",
      channelId: "chan-2",
      guildId: "guild-1",
    });
    expect(inbound.replyTo?.attachments).toHaveLength(1);
    expect(inbound.replyTo?.attachments?.[0]).toMatchObject({
      filename: "original.pdf",
      mimeType: "application/pdf",
      status: "ready",
    });
    expect(existsSync(inbound.replyTo?.attachments?.[0].path || "")).toBe(true);
  });

  it("returns structured attachment errors when a download fails", async () => {
    tmpAttachmentDir = mkdtempSync(join(tmpdir(), "donna-discord-"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));

    const inbound = await buildDiscordInboundContext({
      conversationId: discordConversationId("chan-3"),
      attachmentRootDir: tmpAttachmentDir,
      api: async () => new Response(null, { status: 404 }),
      message: {
        id: "msg-3",
        attachments: [
          {
            id: "att-4",
            filename: "broken.txt",
            content_type: "text/plain",
            size: 4,
            url: "https://cdn.example/broken.txt",
          },
        ],
      },
    });

    expect(inbound.attachments).toEqual([
      expect.objectContaining({
        filename: "broken.txt",
        status: "error",
        error: expect.objectContaining({
          code: "download_failed",
          status: 404,
        }),
      }),
    ]);
  });
});

describe("proactive routing", () => {
  it("retries a transient Pi termination before sending a heartbeat reply", async () => {
    const send = vi.fn(async () => {});
    const queue = new EventQueue();
    const sessionOne = {
      alive: true,
      promptAndWait: vi.fn().mockResolvedValue({ events: [], text: "Pi error: terminated" }),
      stop: vi.fn(),
      onExit: vi.fn(),
    };
    const sessionTwo = {
      alive: true,
      promptAndWait: vi.fn().mockResolvedValue({ events: [], text: "all good now" }),
      stop: vi.fn(),
      onExit: vi.fn(),
    };
    const pool = {
      getOrCreate: vi.fn()
        .mockReturnValueOnce(sessionOne)
        .mockReturnValueOnce(sessionTwo),
      getSkills: vi.fn().mockReturnValue([]),
      getSessionDir: vi.fn().mockReturnValue("/tmp"),
      markBusy: vi.fn(),
      markIdle: vi.fn(),
      kill: vi.fn(),
    };
    const heartbeat = {
      register: vi.fn(),
    };

    createRouter(() => send, pool as any, queue, heartbeat as any);

    queue.push({
      type: "heartbeat",
      jid: "telegram:123",
      prompt: "follow up if needed",
    });

    await vi.waitFor(() => {
      expect(pool.kill).toHaveBeenCalledWith("telegram:123");
      expect(sessionOne.promptAndWait).toHaveBeenCalledTimes(1);
      expect(sessionTwo.promptAndWait).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("telegram:123", { text: "all good now", attachments: [] });
    });
  });

  it("suppresses proactive Pi errors when the retry still fails", async () => {
    const send = vi.fn(async () => {});
    const queue = new EventQueue();
    const sessionOne = {
      alive: true,
      promptAndWait: vi.fn().mockResolvedValue({ events: [], text: "Pi error: terminated" }),
      stop: vi.fn(),
      onExit: vi.fn(),
    };
    const sessionTwo = {
      alive: true,
      promptAndWait: vi.fn().mockResolvedValue({ events: [], text: "Pi error: terminated" }),
      stop: vi.fn(),
      onExit: vi.fn(),
    };
    const pool = {
      getOrCreate: vi.fn()
        .mockReturnValueOnce(sessionOne)
        .mockReturnValueOnce(sessionTwo),
      getSkills: vi.fn().mockReturnValue([]),
      getSessionDir: vi.fn().mockReturnValue("/tmp"),
      markBusy: vi.fn(),
      markIdle: vi.fn(),
      kill: vi.fn(),
    };
    const heartbeat = {
      register: vi.fn(),
    };

    createRouter(() => send, pool as any, queue, heartbeat as any);

    queue.push({
      type: "heartbeat",
      jid: "telegram:456",
      prompt: "follow up if needed",
    });

    await vi.waitFor(() => {
      expect(pool.kill).toHaveBeenCalledWith("telegram:456");
      expect(sessionOne.promptAndWait).toHaveBeenCalledTimes(1);
      expect(sessionTwo.promptAndWait).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    });
  });
});
