import { Bot, type Context } from "grammy";
import pino from "pino";
import { isAllowedTelegramChat } from "./config.js";
import { parseTelegramConversationId, telegramConversationId } from "./conversation-id.js";
import {
  buildUnsupportedAttachmentNotice,
  splitMessage,
  type OutboundMessage,
} from "./messages.js";
import type { IncomingMessage } from "./incoming-message.js";

const log = pino({ name: "telegram" });
const TG_MAX_LENGTH = 4000;

export type TelegramMessageHandler = (message: IncomingMessage) => Promise<void>;

export interface TelegramConnection {
  bot: Bot;
  sendMessage: (conversationId: string, payload: OutboundMessage) => Promise<void>;
  stop: () => void;
}

export function connectTelegram(
  token: string,
  onMessage: TelegramMessageHandler,
): TelegramConnection {
  const bot = new Bot(token);

  // Track sent message IDs to avoid echo (not needed for Telegram bots,
  // but kept for consistency — bots don't receive their own messages)

  bot.on("message:text", async (ctx: Context) => {
    const chatId = String(ctx.chat!.id);
    const text = ctx.message!.text!;
    const from = ctx.from;

    log.info(
      { chatId, from: from?.username || from?.id, text: text.slice(0, 80) },
      "Incoming Telegram message",
    );

    // Allowlist check (use chatId as the identifier)
    if (!isAllowedTelegramChat(chatId)) {
      log.warn({ chatId, from: from?.username }, "Message from non-allowlisted chat — add this chatId to TELEGRAM_ALLOWLIST");
      return;
    }

    await onMessage({ conversationId: telegramConversationId(chatId), text });
  });

  bot.catch((err) => {
    log.error({ err: err.message }, "Bot error");
  });

  // Start polling
  bot.start({
    onStart: () => log.info("Telegram bot started (polling)"),
  });

  async function sendMessage(conversationId: string, payload: OutboundMessage) {
    const chatId = parseTelegramConversationId(conversationId);
    const suffix = buildUnsupportedAttachmentNotice(payload.attachments || []);
    const text = [payload.text, suffix].filter(Boolean).join("\n\n");
    const chunks = splitMessage(text, TG_MAX_LENGTH);
    for (const chunk of chunks) {
      try {
        // Try sending as HTML first (for formatted responses)
        await bot.api.sendMessage(Number(chatId), chunk, {
          parse_mode: "HTML",
        });
      } catch {
        // Fallback to plain text if HTML parsing fails
        await bot.api.sendMessage(Number(chatId), chunk);
      }
    }
  }

  function stop() {
    bot.stop();
    log.info("Telegram bot stopped");
  }

  return { bot, sendMessage, stop };
}
