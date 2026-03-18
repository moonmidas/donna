import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { AgentSession, PromptOptions, PromptResult, RpcEvent } from "./agent-session.js";
import { readSoulPrompt } from "./soul.js";
import { formatActiveSkillsNotice, type GatewaySkill } from "./skills.js";

const log = pino({ name: "pi-rpc" });

/**
 * Wraps a `pi --mode rpc` subprocess.
 * Communicates via JSONL on stdin/stdout.
 */
export class PiRpc extends EventEmitter implements AgentSession {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private resolvedProvider: string;
  private processing = false;
  private pending = new Map<number, {
    resolve: (result: PromptResult) => void;
    reject: (err: Error) => void;
    events: RpcEvent[];
    textBlocks: Map<number, string>;
    completedAssistantText: string;
    assistantStopReason: string;
    assistantErrorMessage: string;
    onEvent?: (event: RpcEvent) => void | Promise<void>;
    timer?: ReturnType<typeof setTimeout>;
    resetTimer?: () => ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private sessionDir: string,
    private cwd: string,
    private provider?: string,
    private model?: string,
    private skills: GatewaySkill[] = [],
  ) {
    super();
    this.resolvedProvider = this.resolveProvider();
  }

  start(): void {
    const authIssue = this.getMissingAuthHint();
    if (authIssue) {
      log.warn({ provider: this.resolvedProvider, hint: authIssue }, "Pi auth appears to be missing");
    }

    const args = ["--mode", "rpc", "--session-dir", this.sessionDir];
    if (this.shouldContinueSession()) {
      args.push("--continue");
    }
    if (this.resolvedProvider) args.push("--provider", this.resolvedProvider);
    if (this.model) args.push("--model", this.model);
    for (const skillPath of new Set(
      this.skills
        .filter((skill) => skill.adapters.pi?.enabled !== false)
        .map((skill) => skill.filePath),
    )) {
      args.push("--skill", skillPath);
    }
    args.push("--append-system-prompt", buildPiAppendSystemPrompt(this.cwd));

    this.proc = spawn("pi", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (this.provider !== this.resolvedProvider) {
      log.info(
        { requestedProvider: this.provider, resolvedProvider: this.resolvedProvider },
        "Pi provider remapped from stored auth",
      );
    }

    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) log.warn({ stderr: msg }, "Pi stderr");
    });

    this.proc.on("exit", (code, signal) => {
      this.rejectAll(new Error(`Pi exited: code=${code} signal=${signal}`));
      this.proc = null;
      this.emit("exit", code, signal);
    });

    this.proc.on("error", (err) => {
      this.rejectAll(err);
      this.proc = null;
      this.emit("exit", -1, err.message);
    });
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  onExit(listener: (code: number, signal: string) => void): void {
    this.on("exit", listener);
  }

  async promptAndWait(
    message: string,
    options: PromptOptions = {},
  ): Promise<PromptResult> {
    if (!this.alive) throw new Error("Pi process not running");

    const id = this.nextId++;
    const activeSkillsNotice = formatActiveSkillsNotice(options.skills ?? []);
    const req: Record<string, unknown> = {
      id,
      type: "prompt",
      message: activeSkillsNotice ? `${activeSkillsNotice}\n\n${message}` : message,
    };
    if (options.images?.length) req.images = options.images;
    const idleTimeout = options.idleTimeout ?? 43_200_000; // 12 hours of silence = timeout (not total time)

    // If Pi is already processing, tell it to queue this message
    if (this.processing) {
      req.streamingBehavior = "followUp";
      log.info({ id }, "Pi busy — sending as followUp");
    }

    this.processing = true;

    return new Promise<PromptResult>((resolve, reject) => {
      const startTimer = () => setTimeout(() => {
        this.pending.delete(id);
        this.processing = this.pending.size > 0;
        reject(new Error(`Pi prompt timed out after ${idleTimeout}ms of inactivity`));
      }, idleTimeout);

      const timer = startTimer();
      this.pending.set(id, {
        resolve,
        reject,
        events: [],
        textBlocks: new Map<number, string>(),
        completedAssistantText: "",
        assistantStopReason: "",
        assistantErrorMessage: "",
        onEvent: options.onEvent,
        timer,
        resetTimer: startTimer,
      });
      this.send(req);
    });
  }

  stop(): void {
    if (!this.proc) return;

    this.rejectAll(new Error("Pi process stopped"));
    this.proc.kill("SIGTERM");

    const proc = this.proc;
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, 3000);

    this.proc = null;
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) {
      log.error({ obj }, "Cannot send — stdin not writable");
      return;
    }
    const line = JSON.stringify(obj) + "\n";
    log.debug({ id: obj.id, type: obj.type }, "Sending to Pi");
    this.proc.stdin.write(line);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let event: RpcEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.type === "session_compact" || event.type === "compaction_start" || event.type === "compaction_end") {
      log.warn({ type: event.type }, "Pi context compaction triggered");
    } else {
      log.debug({ type: event.type, id: event.id, hasCmd: !!event.command, success: event.success }, "Pi event");
    }

    // Route by id, or fallback to the single active pending request
    let pendingKey = event.id != null ? event.id : undefined;
    let pending = pendingKey != null ? this.pending.get(pendingKey) : undefined;
    // Events without id (agent_end, message_update, etc.) route to the last pending
    if (!pending && this.pending.size > 0) {
      const entries = [...this.pending.entries()];
      const last = entries[entries.length - 1];
      pendingKey = last[0];
      pending = last[1];
    }

    if (pending) {
      pending.events.push(event);
      void pending.onEvent?.(event);

      // Reset idle timer — Pi is still active
      if (pending.resetTimer) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = pending.resetTimer();
      }

      if (event.type === "message_update") {
        this.captureAssistantTextDelta(event, pending.textBlocks);
      }

      if (event.type === "message_end" || event.type === "turn_end") {
        const extracted = this.extractAssistantTextFromEventMessage(event);
        if (extracted) {
          pending.completedAssistantText = extracted;
        }
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.role === "assistant") {
          if (typeof message.stopReason === "string") {
            pending.assistantStopReason = message.stopReason;
          }
          if (typeof message.errorMessage === "string") {
            pending.assistantErrorMessage = message.errorMessage;
          }
        }
      }

      // "response" with success:false = immediate error
      if (event.type === "response" && event.success === false) {
        const errText = typeof event.error === "string" ? event.error : "Unknown Pi error";
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(pendingKey!);
        this.processing = this.pending.size > 0;
        log.error({ id: pendingKey, error: errText }, "Pi prompt error");
        pending.resolve({ events: pending.events, text: `Error: ${errText}` });
        return;
      }

      // "response" with success:true = just an ACK, keep waiting

      // agent_end = response complete — extract final text from messages
      if (event.type === "agent_end") {
        let text = (
          this.extractTextFromAgentEnd(event) ||
          pending.completedAssistantText ||
          this.extractTextFromDeltas(pending.textBlocks)
        );
        if (!text && pending.assistantStopReason === "error") {
          text = this.buildAssistantErrorMessage(pending.assistantErrorMessage);
        }
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(pendingKey!);
        this.processing = this.pending.size > 0;
        log.info({ id: pendingKey, textLen: text.length }, "Pi prompt complete");
        pending.resolve({ events: pending.events, text });
      }
    }

    this.emit("event", event);
  }

  /**
   * Extract assistant text from agent_end event.
   * agent_end.messages is an array of {role, content[{type, text}]} objects.
   */
  private extractTextFromAgentEnd(event: RpcEvent): string {
    const messages = event.messages as any[] | undefined;
    if (!Array.isArray(messages)) return "";

    const parts: string[] = [];
    for (const msg of messages) {
      const text = this.extractTextFromMessage(msg);
      if (text) parts.push(text);
    }

    return parts.join("\n").trim();
  }

  private extractAssistantTextFromEventMessage(event: RpcEvent): string {
    const message = event.message as Record<string, unknown> | undefined;
    return this.extractTextFromMessage(message);
  }

  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") return "";

    const msg = message as Record<string, unknown>;
    if (msg.role !== "assistant") return "";

    const content = msg.content;
    if (!Array.isArray(content)) return "";

    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const typedBlock = block as Record<string, unknown>;
      if (typedBlock.type !== "text") continue;

      if (typeof typedBlock.text === "string") {
        parts.push(typedBlock.text);
        continue;
      }

      if (typeof typedBlock.content === "string") {
        parts.push(typedBlock.content);
      }
    }

    return parts.join("\n").trim();
  }

  private captureAssistantTextDelta(event: RpcEvent, textBlocks: Map<number, string>): void {
    const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!assistantMessageEvent) return;

    const contentIndex = typeof assistantMessageEvent.contentIndex === "number"
      ? assistantMessageEvent.contentIndex
      : 0;

    if (
      assistantMessageEvent.type === "text_delta" &&
      typeof assistantMessageEvent.delta === "string"
    ) {
      const current = textBlocks.get(contentIndex) || "";
      textBlocks.set(contentIndex, current + assistantMessageEvent.delta);
      return;
    }

    if (
      assistantMessageEvent.type === "text_end" &&
      typeof assistantMessageEvent.content === "string"
    ) {
      textBlocks.set(contentIndex, assistantMessageEvent.content);
    }
  }

  private extractTextFromDeltas(textBlocks: Map<number, string>): string {
    return [...textBlocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join("\n")
      .trim();
  }

  private buildAssistantErrorMessage(errorMessage: string): string {
    if (errorMessage.trim()) {
      return `Pi error: ${errorMessage.trim()}`;
    }

    const authHint = this.getMissingAuthHint();
    if (authHint) {
      return authHint;
    }

    return "Pi hit an internal error. Check your Pi login or provider configuration."
  }

  private getMissingAuthHint(): string {
    if (this.resolvedProvider === "openai-codex") {
      const auth = this.readPiAuth();
      const codexCred = auth["openai-codex"];
      if (codexCred && typeof codexCred === "object") return "";
      return "Pi is configured for Codex OAuth, but no `openai-codex` login was found. Run `pi`, then `/login`, then choose `ChatGPT Plus/Pro (Codex)`."
    }

    if (this.resolvedProvider === "openai") {
      if (process.env.OPENAI_API_KEY?.trim()) return "";
      const auth = this.readPiAuth();
      const openaiCred = auth.openai;
      if (openaiCred && typeof openaiCred === "object") return "";
      return "Pi is configured for OpenAI, but no OpenAI API key or Codex OAuth login was found. Run `pi`, then `/login`, then choose `ChatGPT Plus/Pro (Codex)`."
    }

    if (this.resolvedProvider === "anthropic") {
      if (process.env.ANTHROPIC_API_KEY?.trim()) return "";
      const auth = this.readPiAuth();
      const anthropicCred = auth.anthropic;
      if (anthropicCred && typeof anthropicCred === "object") return "";
      return "Pi is configured for Anthropic, but no Anthropic API key or OAuth login was found."
    }

    return "";
  }

  private readPiAuth(): Record<string, unknown> {
    try {
      const authPath = join(homedir(), ".pi", "agent", "auth.json");
      if (!existsSync(authPath)) return {};
      const parsed = JSON.parse(readFileSync(authPath, "utf-8"));
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private resolveProvider(): string {
    if (this.provider !== "openai") return this.provider || "";

    const auth = this.readPiAuth();
    const hasOpenAiApiKey = !!process.env.OPENAI_API_KEY?.trim();
    const hasOpenAiAuth = !!auth.openai && typeof auth.openai === "object";
    const hasCodexAuth = !!auth["openai-codex"] && typeof auth["openai-codex"] === "object";

    if (!hasOpenAiApiKey && !hasOpenAiAuth && hasCodexAuth) {
      return "openai-codex";
    }

    return this.provider;
  }

  private shouldContinueSession(): boolean {
    const latestSession = this.getLatestSessionFile();
    if (!latestSession) return false;

    const lastModelChange = this.readLastModelChange(latestSession);
    if (!lastModelChange) return true;

    const sameProvider = !this.resolvedProvider || lastModelChange.provider === this.resolvedProvider;
    const sameModel = !this.model || !lastModelChange.modelId || lastModelChange.modelId === this.model;

    if (!sameProvider || !sameModel) {
      log.info(
        {
          sessionFile: latestSession,
          requestedProvider: this.resolvedProvider,
          requestedModel: this.model,
          sessionProvider: lastModelChange.provider,
          sessionModel: lastModelChange.modelId,
        },
        "Skipping Pi session resume because saved model/provider does not match",
      );
      return false;
    }

    return true;
  }

  private getLatestSessionFile(): string {
    try {
      if (!existsSync(this.sessionDir)) return "";
      const files = readdirSync(this.sessionDir)
        .filter((file) => file.endsWith(".jsonl"))
        .sort();
      const last = files[files.length - 1];
      return last ? join(this.sessionDir, last) : "";
    } catch {
      return "";
    }
  }

  private readLastModelChange(sessionFile: string): { provider: string; modelId: string } | null {
    try {
      const lines = readFileSync(sessionFile, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      let result: { provider: string; modelId: string } | null = null;
      for (const line of lines) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (parsed.type !== "model_change") continue;
        result = {
          provider: typeof parsed.provider === "string" ? parsed.provider : "",
          modelId: typeof parsed.modelId === "string" ? parsed.modelId : "",
        };
      }

      return result;
    } catch {
      return null;
    }
  }

  private rejectAll(err: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.processing = false;
  }
}

export function buildPiAppendSystemPrompt(cwd = process.cwd()): string {
  const soulPrompt = readSoulPrompt(cwd);
  return [
    "You are running as a chat bot inside a messaging app such as Telegram, WhatsApp, or Discord.",
    "You have access to the user's local machine.",
    "Incoming prompts may include a separate `Structured message context JSON` block with attachments and reply metadata; use that JSON as structured context and treat any attachment `path` values as real local files.",
    "Do NOT use local notifications, desktop alerts, or OS-level reminders — the user will never see them.",
    "For reminders and scheduled messages, use the `schedule` tool which delivers messages through the active chat channel.",
    "If the user explicitly asks you to send a local file and the chat platform supports attachments, include one line per file exactly like `[[attachment:/absolute/path/to/file]]`.",
    "you have access to a donna, where you can quickly store and retrieve information. Use it as a scratch pad for short-term memory, storing information you might need later in the conversation, and for storing information that the user explicitly asks you to remember.",
    "most importantly, you are not supposed to forget things so make sure to save as much information as possible to the donna, and retrieve from it often. Always check the donna for relevant information before responding to the user.",
    soulPrompt,
  ].filter(Boolean).join(" ");
}
