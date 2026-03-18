const WHATSAPP_PREFIX = "whatsapp:";
const TELEGRAM_PREFIX = "telegram:";
const DISCORD_PREFIX = "discord:";

export function whatsappConversationId(jid: string): string {
  return `${WHATSAPP_PREFIX}${jid}`;
}

export function telegramConversationId(chatId: string): string {
  return `${TELEGRAM_PREFIX}${chatId}`;
}

export function discordConversationId(channelId: string): string {
  return `${DISCORD_PREFIX}${channelId}`;
}

export function conversationPrefix(id: string): string {
  const idx = id.indexOf(":");
  if (idx === -1) return "";
  return id.slice(0, idx + 1);
}

export function parseWhatsAppConversationId(id: string): string {
  return parseConversationId(id, WHATSAPP_PREFIX);
}

export function parseTelegramConversationId(id: string): string {
  return parseConversationId(id, TELEGRAM_PREFIX);
}

export function parseDiscordConversationId(id: string): string {
  return parseConversationId(id, DISCORD_PREFIX);
}

function parseConversationId(id: string, prefix: string): string {
  if (!id.startsWith(prefix)) {
    throw new Error(`Expected ${prefix} conversation ID, received: ${id}`);
  }
  return id.slice(prefix.length);
}
