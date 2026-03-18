import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { AgentSession, PromptOptions, PromptResult, RpcEvent } from "./agent-session.js";
import { readSoulPrompt } from "./soul.js";
import { formatInlineSkillsForPrompt, type GatewaySkill } from "./skills.js";

const log = pino({ name: "local-model-rpc" });
const SESSION_FILE = "local-model-session.json";
const MAX_HISTORY_MESSAGES = 40;

type ChatRole = "system" | "user" | "assistant";

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface LocalModelRpcOptions {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  skills?: GatewaySkill[];
}

export class LocalModelRpc implements AgentSession {
  private readonly sessionPath: string;
  private history: ChatMessage[] = [];
  private stopped = false;

  constructor(
    private sessionDir: string,
    private options: LocalModelRpcOptions,
  ) {
    this.sessionPath = join(sessionDir, SESSION_FILE);
    mkdirSync(this.sessionDir, { recursive: true });
    this.loadHistory();
  }

  get alive(): boolean {
    return !this.stopped;
  }

  onExit(_listener: (code: number, signal: string) => void): void {
    // Stateless client; nothing to subscribe to.
  }

  async promptAndWait(
    message: string,
    options: PromptOptions = {},
  ): Promise<PromptResult> {
    if (!this.alive) {
      throw new Error("Local model session stopped");
    }

    if (!this.options.baseUrl) {
      throw new Error("LOCAL_MODEL_BASE_URL is required for the local backend");
    }
    if (!this.options.model) {
      throw new Error("LOCAL_MODEL_MODEL is required for the local backend");
    }

    const systemPrompt = buildLocalModelSystemPrompt(
      this.options.provider,
      options.skills ?? [],
      process.cwd(),
    );
    const nextHistory: ChatMessage[] = [
      ...this.history,
      { role: "user", content: message },
    ];
    const trimmedHistory: ChatMessage[] = nextHistory.slice(-MAX_HISTORY_MESSAGES);
    const requestMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...trimmedHistory,
    ];

    const response = await fetch(this.options.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        stream: false,
        messages: requestMessages,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Local model request failed (${response.status}): ${body}`);
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };
    const text = extractAssistantText(payload);
    if (!text) {
      throw new Error("Local model returned no assistant text");
    }

    const updatedHistory: ChatMessage[] = [
      ...trimmedHistory,
      { role: "assistant", content: text },
    ];
    this.history = updatedHistory.slice(-MAX_HISTORY_MESSAGES);
    this.saveHistory();

    const events: RpcEvent[] = [
      { type: "response", provider: this.options.provider, model: this.options.model },
      { type: "agent_message", text },
    ];
    for (const event of events) {
      void options.onEvent?.(event);
    }

    return { events, text };
  }

  stop(): void {
    this.stopped = true;
  }

  private loadHistory(): void {
    if (!existsSync(this.sessionPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.sessionPath, "utf-8")) as { history?: ChatMessage[] };
      if (Array.isArray(raw.history)) {
        this.history = raw.history.filter(
          (entry): entry is ChatMessage =>
            !!entry &&
            (entry.role === "user" || entry.role === "assistant") &&
            typeof entry.content === "string",
        );
      }
    } catch (err) {
      log.warn({ err }, "Failed to load local model session history");
      this.history = [];
    }
  }

  private saveHistory(): void {
    writeFileSync(this.sessionPath, JSON.stringify({ history: this.history }, null, 2), "utf-8");
  }
}

export function buildLocalModelSystemPrompt(
  provider: string,
  skills: GatewaySkill[],
  cwd = process.cwd(),
): string {
  const providerName = provider || "local model";
  const soulPrompt = readSoulPrompt(cwd);
  return [
    `You are Donna running through ${providerName}.`,
    "You are chatting with the user through a messaging app like Telegram, WhatsApp, or Discord.",
    soulPrompt,
    "Reply naturally and concisely, like a human texting.",
    "Incoming prompts may include a separate `Structured message context JSON` block with attachments and reply metadata; use that JSON as structured context instead of mixing it into the raw message text.",
    "You do not have shell, file, or scheduling tools in this mode.",
    "If the user asks you to remember something for later, explain that this backend is conversational-only.",
    "If there is truly nothing to say in response to a heartbeat prompt, answer with exactly: NOTHING",
    formatInlineSkillsForPrompt(skills, "Active project skills for this request:", "local"),
  ].filter(Boolean).join("\n");
}

function extractAssistantText(payload: {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
}): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text || "")
      .join("")
      .trim();
  }
  return "";
}
