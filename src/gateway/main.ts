import { mkdirSync } from "node:fs";
import pino from "pino";
import {
  AGENT_BACKEND,
  SESSIONS_DIR,
  AUTH_DIR,
  ALLOWLIST,
  ATTACHMENTS_DIR,
  DISCORD_BOT_TOKEN,
  GATEWAY_DIR,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWLIST,
} from "./config.js";
import { AgentPool } from "./agent-pool.js";
import {
  conversationPrefix,
  telegramConversationId,
  whatsappConversationId,
} from "./conversation-id.js";
import { connectDiscord, type DiscordConnection } from "./discord.js";
import { connectWhatsApp } from "./whatsapp.js";
import { connectTelegram, type TelegramConnection } from "./telegram.js";
import { createRouter } from "./router.js";
import { EventQueue } from "./event-queue.js";
import { CronScheduler } from "./cron.js";
import { HeartbeatManager } from "./heartbeat.js";
import type { SendFn } from "./messages.js";
import type { IncomingMessage } from "./incoming-message.js";

const log = pino({ name: "gateway" });

async function main() {
  log.info({ backend: AGENT_BACKEND }, "Starting Gateway for Donna");

  // Ensure runtime dirs exist
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(AUTH_DIR, { recursive: true });
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  mkdirSync(`${GATEWAY_DIR}/cron`, { recursive: true });

  // Initialize proactive system
  const eventQueue = new EventQueue();
  const heartbeat = new HeartbeatManager(eventQueue);
  const cron = new CronScheduler(eventQueue);
  const pool = new AgentPool();

  // Route outbound messages by explicit conversation ID prefix.
  const senders = new Map<string, SendFn>();

  function universalSend(id: string, payload: Parameters<SendFn>[1]): Promise<unknown> {
    const sender = senders.get(conversationPrefix(id));
    if (sender) return sender(id, payload);
    log.error({ id }, "No sender registered for this ID");
    return Promise.resolve();
  }

  const router = createRouter(() => universalSend, pool, eventQueue, heartbeat);

  // --- WhatsApp ---
  let waConnected = false;
  if (ALLOWLIST.size > 0) {
    log.info({ count: ALLOWLIST.size }, "WhatsApp allowlist configured");
    try {
      const conn = await connectWhatsApp(async (message: IncomingMessage) => {
        cron.setDefaultJid(message.conversationId);
        heartbeat.register(message.conversationId);
        await router(message);
      });
      senders.set("whatsapp:", conn.sendMessage);

      // Set default JID for cron
      if (ALLOWLIST.size === 1) {
        const defaultJid = whatsappConversationId([...ALLOWLIST][0]);
        cron.setDefaultJid(defaultJid);
        heartbeat.register(defaultJid);
        log.info({ jid: defaultJid }, "Default JID set from WhatsApp allowlist");
      }
      await conn.ready;
      waConnected = true;
      log.info("WhatsApp connected");
    } catch (err) {
      log.error({ err }, "Failed to connect WhatsApp — continuing without it");
    }
  } else {
    log.info("No GATEWAY_ALLOWLIST — skipping WhatsApp");
  }

  // --- Telegram ---
  let tgConnection: TelegramConnection | null = null;
  let discordConnection: DiscordConnection | null = null;
  if (TELEGRAM_BOT_TOKEN) {
    log.info(
      { allowlistCount: TELEGRAM_ALLOWLIST.size },
      "Telegram bot token found — starting bot",
    );

    // Wrap router for Telegram: agent response goes through Telegram sendMessage
    tgConnection = connectTelegram(TELEGRAM_BOT_TOKEN, async (message: IncomingMessage) => {
      cron.setDefaultJid(message.conversationId);
      heartbeat.register(message.conversationId);
      await router(message);
    });

    senders.set("telegram:", tgConnection.sendMessage);

    // Set default JID for cron if no WhatsApp default
    if (!waConnected && TELEGRAM_ALLOWLIST.size === 1) {
      const defaultId = telegramConversationId([...TELEGRAM_ALLOWLIST][0]);
      cron.setDefaultJid(defaultId);
      heartbeat.register(defaultId);
      log.info({ chatId: defaultId }, "Default ID set from Telegram allowlist");
    }

    log.info("Telegram bot started");
  } else {
    log.info("No TELEGRAM_BOT_TOKEN — skipping Telegram");
  }

  // --- Discord ---
  if (DISCORD_BOT_TOKEN) {
    log.info("Discord bot token found — starting bot");
    discordConnection = connectDiscord(DISCORD_BOT_TOKEN, async (message: IncomingMessage) => {
      cron.setDefaultJid(message.conversationId);
      heartbeat.register(message.conversationId);
      await router(message);
    });
    senders.set("discord:", discordConnection.sendMessage);
    await discordConnection.ready;
    log.info("Discord bot started");
  } else {
    log.info("No DISCORD_BOT_TOKEN — skipping Discord");
  }

  if (!waConnected && !tgConnection && !discordConnection) {
    log.error("No channels configured — set GATEWAY_ALLOWLIST, TELEGRAM_BOT_TOKEN, and/or DISCORD_BOT_TOKEN");
    process.exit(1);
  }

  // Start proactive systems
  cron.start();
  log.info("Gateway ready — proactive systems active");

  const shutdown = () => {
    log.info("Shutting down...");
    cron.stop();
    heartbeat.stopAll();
    pool.stopAll();
    if (tgConnection) tgConnection.stop();
    if (discordConnection) discordConnection.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
