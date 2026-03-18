import type { ProgressController } from "./progress.js";

export interface AttachmentProcessingError {
  code: string;
  message: string;
  status?: number;
}

export interface MessageAttachment {
  filename: string;
  path?: string;
  mimeType?: string;
  size?: number;
  sourceUrl?: string;
  attachmentId?: string;
  status: "ready" | "error";
  error?: AttachmentProcessingError;
}

export interface ReplyContext {
  messageId: string;
  author?: string;
  authorId?: string;
  text?: string;
  timestamp?: string;
  channelId?: string;
  guildId?: string;
  threadId?: string;
  attachments?: MessageAttachment[];
  error?: AttachmentProcessingError;
}

export interface IncomingMessage {
  conversationId: string;
  text: string;
  attachments?: MessageAttachment[];
  replyTo?: ReplyContext;
  progress?: ProgressController;
}

export function formatIncomingMessageForAgent(message: IncomingMessage): string {
  const context = buildStructuredContext(message);
  if (!context) {
    return message.text;
  }

  return [
    "User message text:",
    message.text || "(no text)",
    "",
    "Structured message context JSON:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

function buildStructuredContext(message: IncomingMessage): Record<string, unknown> | null {
  const context: Record<string, unknown> = {};

  if (message.attachments?.length) {
    context.attachments = message.attachments;
  }

  if (message.replyTo) {
    context.replyTo = message.replyTo;
  }

  return Object.keys(context).length > 0 ? context : null;
}
