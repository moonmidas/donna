import { basename, isAbsolute } from "node:path";

export interface OutboundMessage {
  text?: string;
  attachments?: string[];
}

export type SendFn = (conversationId: string, payload: OutboundMessage) => Promise<unknown>;

const ATTACHMENT_LINE = /^\[\[attachment:(.+?)\]\]$/gim;

export function parseOutboundMessage(text: string): OutboundMessage {
  const attachments: string[] = [];

  const cleaned = text
    .replace(ATTACHMENT_LINE, (_, rawPath: string) => {
      const filePath = rawPath.trim();
      if (filePath) attachments.push(filePath);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: cleaned || undefined,
    attachments,
  };
}

export function splitMessage(text: string, maxLen: number): string[] {
  if (!text) return [];
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.3) {
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function buildUnsupportedAttachmentNotice(attachments: string[]): string {
  if (attachments.length === 0) return "";
  const fileList = attachments.map((path) => `- ${basename(path)}`).join("\n");
  return `Attachment delivery is not supported on this channel yet.\n${fileList}`;
}

export function normalizeAttachmentPaths(paths: string[]): string[] {
  return paths.filter((path) => isAbsolute(path));
}
