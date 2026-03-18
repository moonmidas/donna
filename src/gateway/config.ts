import { createHash } from "node:crypto";
import { resolve } from "node:path";
import "dotenv/config";

// Project root: src/gateway/ → src/ → donna/
export const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

export const GATEWAY_DIR = resolve(PROJECT_ROOT, ".gateway");
export const SESSIONS_DIR = resolve(GATEWAY_DIR, "sessions");
export const AUTH_DIR = resolve(GATEWAY_DIR, "auth");
export const ATTACHMENTS_DIR = resolve(GATEWAY_DIR, "attachments");

export const ALLOWLIST: Set<string> = new Set(
  (process.env.GATEWAY_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Telegram config
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_ALLOWLIST: Set<string> = new Set(
  (process.env.TELEGRAM_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Discord config
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
export const DISCORD_ALLOWED_USER_IDS: Set<string> = new Set(
  (process.env.DISCORD_ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
export const DISCORD_REQUIRE_MENTION = boolFromEnv("DISCORD_REQUIRE_MENTION", true);

function boolFromEnv(name: string, fallback = false): boolean {
  const value = (process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function defaultLocalModelBaseUrl(provider: string): string {
  if (provider === "ollama") return "http://127.0.0.1:11434/v1";
  if (provider === "mlx") return "http://127.0.0.1:8080/v1";
  return "";
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed.slice(0, -"/chat/completions".length);
  }
  return trimmed;
}

function splitListEnv(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const AGENT_BACKEND = (process.env.AGENT_BACKEND || "pi").trim().toLowerCase();
export const AGENT_PROVIDER = process.env.AGENT_PROVIDER || process.env.PI_PROVIDER || "anthropic";
export const AGENT_MODEL = process.env.AGENT_MODEL || process.env.PI_MODEL || "";
export const AGENT_SKILL_PATHS = splitListEnv(
  process.env.AGENT_SKILL_PATHS || process.env.PI_SKILL_PATHS || "",
);

export const PI_PROVIDER = AGENT_PROVIDER;
export const PI_MODEL = AGENT_MODEL;
export const CODEX_USE_OSS = boolFromEnv("CODEX_USE_OSS");
export const CODEX_LOCAL_PROVIDER = (process.env.CODEX_LOCAL_PROVIDER || "").trim().toLowerCase();
export const CODEX_FULL_AUTO = boolFromEnv("CODEX_FULL_AUTO", true);
export const LOCAL_MODEL_PROVIDER = (
  process.env.LOCAL_MODEL_PROVIDER ||
  (AGENT_BACKEND === "local" ? "ollama" : "")
).trim().toLowerCase();
export const LOCAL_MODEL_API_KEY = process.env.LOCAL_MODEL_API_KEY || "";
const localModelBase = normalizeBaseUrl(
  process.env.LOCAL_MODEL_BASE_URL || defaultLocalModelBaseUrl(LOCAL_MODEL_PROVIDER),
);
export const LOCAL_MODEL_BASE_URL = localModelBase
  ? `${localModelBase}/chat/completions`
  : "";
export const PI_IDLE_TIMEOUT_MS = Number(process.env.PI_IDLE_TIMEOUT_MS) || 300_000;
export const MAX_PI_PROCESSES = Number(process.env.MAX_PI_PROCESSES) || 5;

// Proactive system config
export const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 1_800_000; // 30 min
export const QUIET_HOURS_START = Number(process.env.QUIET_HOURS_START ?? 22); // 10 PM
export const QUIET_HOURS_END = Number(process.env.QUIET_HOURS_END ?? 8); // 8 AM
export const CRON_EVAL_INTERVAL_MS = Number(process.env.CRON_EVAL_INTERVAL_MS) || 60_000; // 1 min
export const MEMORY_REFLECTION_HOUR = Number(process.env.MEMORY_REFLECTION_HOUR ?? 9);
export const MEMORY_REFLECTION_MINUTE = Number(process.env.MEMORY_REFLECTION_MINUTE ?? 0);
export const MEMORY_REFLECTION_MAX_NOTES = Number(process.env.MEMORY_REFLECTION_MAX_NOTES ?? 10);

/** Stable hash of a JID for filesystem-safe directory names */
export function jidHash(jid: string): string {
  return createHash("sha256").update(jid).digest("hex").slice(0, 16);
}

export function isAllowedWhatsAppJid(jid: string): boolean {
  if (ALLOWLIST.size === 0) return true;
  return ALLOWLIST.has(jid);
}

export function isAllowedTelegramChat(chatId: string): boolean {
  if (TELEGRAM_ALLOWLIST.size === 0) return true;
  return TELEGRAM_ALLOWLIST.has(chatId);
}

export function isAllowedDiscordUser(userId: string): boolean {
  if (DISCORD_ALLOWED_USER_IDS.size === 0) return false;
  return DISCORD_ALLOWED_USER_IDS.has(userId);
}
