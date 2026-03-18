import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import pino from "pino";
import { ATTACHMENTS_DIR, jidHash } from "./config.js";
import type {
  AttachmentProcessingError,
  MessageAttachment,
  ReplyContext,
} from "./incoming-message.js";

const log = pino({ name: "discord-inbound" });

interface DiscordApi {
  (path: string, init?: RequestInit): Promise<Response>;
}

interface DiscordInboundOptions {
  message: any;
  conversationId: string;
  api: DiscordApi;
  attachmentRootDir?: string;
}

export interface DiscordInboundContext {
  attachments: MessageAttachment[];
  replyTo?: ReplyContext;
}

export async function buildDiscordInboundContext(
  options: DiscordInboundOptions,
): Promise<DiscordInboundContext> {
  const attachmentRootDir = options.attachmentRootDir || ATTACHMENTS_DIR;
  const messageId = String(options.message?.id || "");
  const attachmentDir = join(
    attachmentRootDir,
    jidHash(options.conversationId),
    messageId || "unknown-message",
  );

  const attachments = await collectDiscordAttachments(
    options.message?.attachments,
    attachmentDir,
    "incoming",
  );
  const replyTo = await buildReplyContext(
    options.message,
    options.api,
    attachmentDir,
  );
  log.info(
    {
      messageId,
      attachmentCount: attachments.length,
      replyMessageId: replyTo?.messageId || null,
      replyAttachmentCount: replyTo?.attachments?.length || 0,
    },
    "Built Discord inbound context",
  );

  return {
    attachments,
    replyTo,
  };
}

export async function collectDiscordAttachments(
  attachments: unknown,
  targetDir: string,
  scope: "incoming" | "reply",
): Promise<MessageAttachment[]> {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  log.info({ scope, targetDir, count: attachments.length }, "Processing Discord attachments");
  mkdirSync(targetDir, { recursive: true });

  const results: MessageAttachment[] = [];
  for (const [index, rawAttachment] of attachments.entries()) {
    results.push(await persistDiscordAttachment(rawAttachment, targetDir, index));
  }
  return results;
}

async function buildReplyContext(
  message: any,
  api: DiscordApi,
  attachmentDir: string,
): Promise<ReplyContext | undefined> {
  const reference = message?.message_reference;
  const replyMessageId = String(reference?.message_id || "");
  if (!replyMessageId) return undefined;

  const channelId = String(reference?.channel_id || message?.channel_id || "");
  let referencedMessage = message?.referenced_message;
  let error: AttachmentProcessingError | undefined;

  if (!referencedMessage && channelId) {
    try {
      log.info({ replyMessageId, channelId }, "Fetching referenced Discord message");
      const response = await api(`/channels/${channelId}/messages/${replyMessageId}`);
      if (!response.ok) {
        const body = await response.text();
        error = {
          code: "reply_lookup_failed",
          message: `Discord reply lookup failed (${response.status}): ${body}`,
          status: response.status,
        };
        log.warn({ replyMessageId, channelId, status: response.status }, "Failed to fetch referenced Discord message");
      } else {
        referencedMessage = await response.json();
      }
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      error = {
        code: "reply_lookup_error",
        message: messageText,
      };
      log.warn({ replyMessageId, channelId, err }, "Discord reply lookup errored");
    }
  }

  const replyAttachments = referencedMessage
    ? await collectDiscordAttachments(
        referencedMessage.attachments,
        join(attachmentDir, "reply", replyMessageId),
        "reply",
      )
    : [];

  return {
    messageId: replyMessageId,
    author: resolveDiscordAuthorName(referencedMessage?.author, referencedMessage?.member),
    authorId: stringOrUndefined(referencedMessage?.author?.id),
    text: typeof referencedMessage?.content === "string" ? referencedMessage.content : undefined,
    timestamp: stringOrUndefined(referencedMessage?.timestamp),
    channelId: stringOrUndefined(channelId),
    guildId: stringOrUndefined(reference?.guild_id || message?.guild_id),
    threadId: stringOrUndefined(message?.thread?.id),
    attachments: replyAttachments.length > 0 ? replyAttachments : undefined,
    error,
  };
}

async function persistDiscordAttachment(
  rawAttachment: unknown,
  targetDir: string,
  index: number,
): Promise<MessageAttachment> {
  const attachment = rawAttachment && typeof rawAttachment === "object"
    ? rawAttachment as Record<string, unknown>
    : {};
  const filename = normalizedFilename(
    typeof attachment.filename === "string" ? attachment.filename : undefined,
    typeof attachment.id === "string" ? attachment.id : undefined,
    index,
  );
  const sourceUrl = stringOrUndefined(attachment.url) || stringOrUndefined(attachment.proxy_url);
  const attachmentId = stringOrUndefined(attachment.id);
  const mimeType =
    stringOrUndefined(attachment.content_type) ||
    inferMimeType(filename);
  const reportedSize = numberOrUndefined(attachment.size);

  if (!sourceUrl) {
    const error = {
      code: "missing_url",
      message: "Discord attachment did not include a downloadable URL.",
    };
    log.warn({ attachmentId, filename }, "Discord attachment missing URL");
    return {
      filename,
      mimeType,
      size: reportedSize,
      attachmentId,
      status: "error",
      error,
    };
  }

  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      const error = {
        code: "download_failed",
        message: `Discord attachment download failed (${response.status})`,
        status: response.status,
      };
      log.warn({ attachmentId, filename, status: response.status }, "Discord attachment download failed");
      return {
        filename,
        mimeType,
        size: reportedSize,
        sourceUrl,
        attachmentId,
        status: "error",
        error,
      };
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const destination = join(targetDir, buildStoredFilename(filename, attachmentId, index));
    writeFileSync(destination, bytes);

    log.info({ attachmentId, filename, destination, size: bytes.length }, "Stored Discord attachment");
    return {
      filename,
      path: destination,
      mimeType,
      size: reportedSize ?? bytes.length,
      sourceUrl,
      attachmentId,
      status: "ready",
    };
  } catch (err) {
    const error = {
      code: "download_error",
      message: err instanceof Error ? err.message : String(err),
    };
    log.warn({ attachmentId, filename, err }, "Discord attachment download errored");
    return {
      filename,
      mimeType,
      size: reportedSize,
      sourceUrl,
      attachmentId,
      status: "error",
      error,
    };
  }
}

function resolveDiscordAuthorName(author: any, member: any): string | undefined {
  return (
    stringOrUndefined(member?.nick) ||
    stringOrUndefined(author?.global_name) ||
    stringOrUndefined(author?.username)
  );
}

function normalizedFilename(filename: string | undefined, attachmentId: string | undefined, index: number): string {
  const base = sanitizeFilename(filename || `attachment-${attachmentId || index}`);
  return base || `attachment-${attachmentId || index}`;
}

function buildStoredFilename(filename: string, attachmentId: string | undefined, index: number): string {
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const suffix = sanitizeFilename(attachmentId || String(index)).slice(0, 32) || String(index);
  return `${stem}-${suffix}${extension}`.slice(0, 180);
}

function sanitizeFilename(value: string): string {
  return value
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 140);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function inferMimeType(filename: string): string | undefined {
  const extension = extname(filename).toLowerCase();
  switch (extension) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    default:
      return undefined;
  }
}
