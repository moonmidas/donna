import { createInterface } from "node:readline/promises"
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { stdin, stdout } from "node:process"

const ENV_PATH = ".env"
const TMP_PATH = ".env.tmp"

function parseEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const vars: Record<string, string> = {}
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return vars
}

function mask(value: string): string {
  if (value.length <= 8) return "****"
  return value.slice(0, 6) + "..." + value.slice(-4)
}

function validateAnthropicApiKey(v: string): string | null {
  if (!v.startsWith("sk-ant-")) return "API key must start with 'sk-ant-'"
  return null
}

function validateOpenAiApiKey(v: string): string | null {
  if (!v.trim()) return "API key is required"
  return null
}

function validateBotToken(v: string): string | null {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(v)) return "Token format: 123456:ABC-DEF..."
  return null
}

function validateChatId(v: string): string | null {
  if (!/^\d+$/.test(v)) return "Chat ID must be numeric"
  return null
}

function validateDiscordUserIds(v: string): string | null {
  const ids = v
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)

  if (ids.length === 0) return "Enter at least one Discord user ID"
  if (ids.some((id) => !/^\d+$/.test(id))) {
    return "Discord user IDs must be numeric, comma-separated values"
  }
  return null
}

function validateUrl(v: string): string | null {
  try {
    new URL(v)
    return null
  } catch {
    return "Enter a full URL like http://127.0.0.1:11434/v1"
  }
}

function validateChoice(choices: string[]) {
  const allowed = new Set(choices.map((choice) => choice.toLowerCase()))
  return (value: string): string | null => {
    if (!allowed.has(value.toLowerCase())) {
      return `Choose one of: ${choices.join(", ")}`
    }
    return null
  }
}

function defaultLocalBaseUrl(provider: string): string {
  if (provider === "ollama") return "http://127.0.0.1:11434/v1"
  if (provider === "mlx") return "http://127.0.0.1:8080/v1"
  return ""
}

function inferPiMode(existing: Record<string, string>): string {
  const provider = (existing["AGENT_PROVIDER"] || existing["PI_PROVIDER"] || "").toLowerCase()
  if (provider === "anthropic") return "anthropic-api"
  if (provider === "openai-codex") return "codex-oauth"
  if (provider === "openai") {
    return existing["OPENAI_API_KEY"] ? "openai-api" : "codex-oauth"
  }
  return "other"
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout })
  const existing = parseEnv(ENV_PATH)

  console.log()
  console.log("  Donna Setup Wizard")
  console.log("  ====================")
  console.log()

  if (Object.keys(existing).length > 0) {
    console.log("  Existing .env detected — press Enter to keep current values.")
    console.log()
  }

  async function ask(
    label: string,
    help: string,
    envKey: string,
    opts: {
      required?: boolean
      validate?: (v: string) => string | null
      defaultValue?: string
    } = {},
  ): Promise<string> {
    const current = existing[envKey]
    const fallback = opts.defaultValue ?? ""
    const showDefault = current ? mask(current) : fallback || undefined

    console.log(`  ${help}`)
    const prompt = showDefault ? `  ${label} [${showDefault}]: ` : `  ${label}: `

    while (true) {
      const answer = (await rl.question(prompt)).trim()

      if (!answer) {
        if (current) return current
        if (fallback) return fallback
        if (opts.required) {
          console.log("  This field is required.\n")
          continue
        }
        return ""
      }

      if (opts.validate) {
        const err = opts.validate(answer)
        if (err) {
          console.log(`  ${err}\n`)
          continue
        }
      }
      return answer
    }
  }

  const existingBackend = (existing["AGENT_BACKEND"] || "pi").toLowerCase()

  console.log("  ── Agent Backend ───────────────────────────────────")
  console.log()
  const backend = (
    await ask(
      "Backend",
      "Choose an agent backend: pi, codex, or local:",
      "AGENT_BACKEND",
      {
        required: true,
        validate: validateChoice(["pi", "codex", "local"]),
        defaultValue: existingBackend || "pi",
      },
    )
  ).toLowerCase()
  console.log()

  let agentProvider = existing["AGENT_PROVIDER"] || existing["PI_PROVIDER"] || "anthropic"
  let agentModel = existing["AGENT_MODEL"] || existing["PI_MODEL"] || ""
  let anthropicKey = existing["ANTHROPIC_API_KEY"] || ""
  let openaiKey = existing["OPENAI_API_KEY"] || ""
  let codexUseOss = existing["CODEX_USE_OSS"] || "false"
  let codexLocalProvider = existing["CODEX_LOCAL_PROVIDER"] || ""
  let localModelProvider = existing["LOCAL_MODEL_PROVIDER"] || ""
  let localModelBaseUrl = existing["LOCAL_MODEL_BASE_URL"] || ""
  let localModelApiKey = existing["LOCAL_MODEL_API_KEY"] || ""

  if (backend === "pi") {
    console.log("  ── Pi Backend ──────────────────────────────────────")
    console.log()
    const piMode = (
      await ask(
        "Mode",
        "Choose a Pi mode: anthropic-api, openai-api, codex-oauth, or other:",
        "PI_MODE",
        {
          required: true,
          validate: validateChoice(["anthropic-api", "openai-api", "codex-oauth", "other"]),
          defaultValue: inferPiMode(existing),
        },
      )
    ).toLowerCase()
    console.log()

    if (piMode === "anthropic-api") {
      agentProvider = "anthropic"
      openaiKey = ""
      console.log("  Note: Anthropic Max plan does NOT work (third-party OAuth")
      console.log("  was blocked Jan 2026). You need an API key from:")
      console.log("  https://console.anthropic.com/")
      console.log()
      anthropicKey = await ask(
        "Anthropic API key",
        "Paste your sk-ant-... key:",
        "ANTHROPIC_API_KEY",
        { required: true, validate: validateAnthropicApiKey },
      )
      console.log()
    }

    if (piMode === "openai-api") {
      agentProvider = "openai"
      anthropicKey = ""
      openaiKey = await ask(
        "OpenAI API key",
        "Paste your OpenAI API key:",
        "OPENAI_API_KEY",
        { required: true, validate: validateOpenAiApiKey },
      )
      console.log()
    }

    if (piMode === "codex-oauth") {
      agentProvider = "openai-codex"
      anthropicKey = ""
      openaiKey = ""
      const piAuthPath = join(homedir(), ".pi", "agent", "auth.json")
      console.log("  Pi will use ChatGPT Plus/Pro (Codex) OAuth for the OpenAI provider.")
      console.log("  Run `pi`, then `/login`, then choose `ChatGPT Plus/Pro (Codex)`.")
      if (existsSync(piAuthPath)) {
        console.log(`  Existing Pi auth file found at ${piAuthPath}.`)
      } else {
        console.log(`  No Pi auth file found yet at ${piAuthPath}.`)
      }
      console.log()
    }

    if (piMode === "other") {
      agentProvider = (
        await ask(
          "Provider",
          "Pi provider name (openai/google/github-copilot/etc):",
          "AGENT_PROVIDER",
          {
            required: true,
            defaultValue: agentProvider,
          },
        )
      ).toLowerCase()
      console.log()
    }

    agentModel = await ask(
      "Model",
      "Pi model ID (press Enter for Pi's default):",
      "AGENT_MODEL",
    )
    console.log()
  } else if (backend === "codex") {
    console.log("  ── Codex Backend ───────────────────────────────────")
    console.log()
    const codexMode = (
      await ask(
        "Mode",
        "Use Codex remotely or against local Ollama? (remote/ollama):",
        "CODEX_MODE",
        {
          required: true,
          validate: validateChoice(["remote", "ollama"]),
          defaultValue: existing["CODEX_USE_OSS"] === "true" ? "ollama" : "remote",
        },
      )
    ).toLowerCase()
    console.log()

    codexUseOss = codexMode === "ollama" ? "true" : "false"
    codexLocalProvider = codexMode === "ollama" ? "ollama" : ""
    agentProvider = "codex"
    agentModel = await ask(
      "Model",
      codexMode === "ollama"
        ? "Local Ollama model ID (for example qwen3.5:9b):"
        : "Codex model ID (press Enter to use your Codex default):",
      "AGENT_MODEL",
      { required: codexMode === "ollama" },
    )
    console.log()
  } else {
    console.log("  ── Local Model Backend ─────────────────────────────")
    console.log()
    localModelProvider = (
      await ask(
        "Provider",
        "Choose a local OpenAI-compatible server: ollama or mlx:",
        "LOCAL_MODEL_PROVIDER",
        {
          required: true,
          validate: validateChoice(["ollama", "mlx"]),
          defaultValue: localModelProvider || "ollama",
        },
      )
    ).toLowerCase()
    console.log()

    agentProvider = localModelProvider
    agentModel = await ask(
      "Model",
      "Model ID served by that backend:",
      "AGENT_MODEL",
      { required: true },
    )
    console.log()

    localModelBaseUrl = await ask(
      "Base URL",
      "OpenAI-compatible base URL (press Enter for the usual local default):",
      "LOCAL_MODEL_BASE_URL",
      {
        required: true,
        defaultValue: defaultLocalBaseUrl(localModelProvider),
        validate: validateUrl,
      },
    )
    console.log()

    localModelApiKey = await ask(
      "API key",
      "API key (press Enter if your local server does not require one):",
      "LOCAL_MODEL_API_KEY",
    )
    console.log()
  }

  console.log("  ── Telegram (optional) ──────────────────────────────")
  console.log()
  const botToken = await ask(
    "Bot token",
    "Create a bot via @BotFather on Telegram, paste the token, or press Enter to skip:",
    "TELEGRAM_BOT_TOKEN",
    { validate: validateBotToken },
  )
  console.log()

  let chatId = existing["TELEGRAM_ALLOWLIST"] || ""
  if (botToken) {
    chatId = await ask(
      "Chat ID",
      "Send /start to @userinfobot on Telegram to get your chat ID:",
      "TELEGRAM_ALLOWLIST",
      { required: true, validate: validateChatId },
    )
    console.log()
  } else {
    chatId = ""
  }

  console.log("  ── WhatsApp (optional) ──────────────────────────────")
  console.log()
  const whatsappJid = await ask(
    "WhatsApp JID",
    "Your JID (e.g. 1234567890@s.whatsapp.net) — press Enter to skip:",
    "GATEWAY_ALLOWLIST",
  )
  console.log()

  console.log("  ── Discord (optional) ───────────────────────────────")
  console.log()
  const discordBotToken = await ask(
    "Bot token",
    "Create a Discord bot in the Developer Portal, paste the token, or press Enter to skip:",
    "DISCORD_BOT_TOKEN",
  )
  console.log()

  let discordAllowedUserIds = existing["DISCORD_ALLOWED_USER_IDS"] || ""
  if (discordBotToken) {
    discordAllowedUserIds = await ask(
      "Allowed user IDs",
      "Comma-separated Discord user IDs that are allowed to talk to the bot:",
      "DISCORD_ALLOWED_USER_IDS",
      { required: true, validate: validateDiscordUserIds },
    )
    console.log()
  } else {
    discordAllowedUserIds = ""
  }

  if (!botToken && !whatsappJid && !discordBotToken) {
    throw new Error("Configure at least one messaging channel (Telegram, WhatsApp, or Discord).")
  }

  rl.close()

  const env = `\
# ── Messaging Channels ─────────────────────────────────────────
# Configure at least one channel (WhatsApp, Telegram, or Discord).

# WhatsApp (optional — skip if only using Telegram)
GATEWAY_ALLOWLIST=${whatsappJid}

# Telegram
TELEGRAM_BOT_TOKEN=${botToken}
TELEGRAM_ALLOWLIST=${chatId}

# Discord
DISCORD_BOT_TOKEN=${discordBotToken}
DISCORD_ALLOWED_USER_IDS=${discordAllowedUserIds}
DISCORD_REQUIRE_MENTION=${existing["DISCORD_REQUIRE_MENTION"] || "true"}

# ── Agent Backend ─────────────────────────────────────────────
AGENT_BACKEND=${backend}
AGENT_PROVIDER=${agentProvider}
AGENT_MODEL=${agentModel}

# Legacy Pi compatibility (safe to keep even when using another backend)
PI_PROVIDER=${agentProvider}
PI_MODEL=${agentModel}

# Pi provider credentials
ANTHROPIC_API_KEY=${anthropicKey}
OPENAI_API_KEY=${openaiKey}

# Codex backend
CODEX_USE_OSS=${codexUseOss}
CODEX_LOCAL_PROVIDER=${codexLocalProvider}
CODEX_FULL_AUTO=${existing["CODEX_FULL_AUTO"] || "true"}

# Local OpenAI-compatible backend (Ollama / MLX)
LOCAL_MODEL_PROVIDER=${localModelProvider}
LOCAL_MODEL_BASE_URL=${localModelBaseUrl}
LOCAL_MODEL_API_KEY=${localModelApiKey}

# ── Agent Session Pool ────────────────────────────────────────
PI_IDLE_TIMEOUT_MS=${existing["PI_IDLE_TIMEOUT_MS"] || "300000"}
MAX_PI_PROCESSES=${existing["MAX_PI_PROCESSES"] || "5"}

# ── Proactive System ─────────────────────────────────────────
HEARTBEAT_INTERVAL_MS=${existing["HEARTBEAT_INTERVAL_MS"] || "1800000"}
QUIET_HOURS_START=${existing["QUIET_HOURS_START"] || "22"}
QUIET_HOURS_END=${existing["QUIET_HOURS_END"] || "8"}
CRON_EVAL_INTERVAL_MS=${existing["CRON_EVAL_INTERVAL_MS"] || "60000"}
`

  writeFileSync(TMP_PATH, env, "utf-8")
  renameSync(TMP_PATH, ENV_PATH)

  console.log("  .env written successfully.")
  console.log()
  console.log("  Ready! Run `npm run dev` to start.")
  console.log()
}

main().catch((err) => {
  console.error("Setup failed:", err)
  process.exit(1)
})
