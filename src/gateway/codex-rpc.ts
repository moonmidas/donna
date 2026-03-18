import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import pino from "pino";
import type { AgentSession, PromptOptions, PromptResult, RpcEvent } from "./agent-session.js";
import { readSoulPrompt } from "./soul.js";
import { formatInlineSkillsForPrompt, formatSkillsCatalogForPrompt, type GatewaySkill } from "./skills.js";

const log = pino({ name: "codex-rpc" });

interface CodexRpcOptions {
  model?: string;
  useOss?: boolean;
  localProvider?: string;
  fullAuto?: boolean;
  skills?: GatewaySkill[];
}

interface CodexJsonEvent {
  type: string;
  [key: string]: unknown;
}

export class CodexRpc implements AgentSession {
  private readonly codexHome: string;
  private readonly threadIdPath: string;
  private readonly outputPath: string;
  private threadId = "";
  private currentProc: ChildProcess | null = null;
  private stopped = false;
  private exitListeners: Array<(code: number, signal: string) => void> = [];

  constructor(
    private sessionDir: string,
    private cwd: string,
    private options: CodexRpcOptions = {},
  ) {
    this.codexHome = join(sessionDir, ".codex");
    this.threadIdPath = join(sessionDir, "codex-thread-id.txt");
    this.outputPath = join(sessionDir, "codex-last-message.txt");
    mkdirSync(this.sessionDir, { recursive: true });
    mkdirSync(this.codexHome, { recursive: true });

    if (existsSync(this.threadIdPath)) {
      this.threadId = readFileSync(this.threadIdPath, "utf-8").trim();
    }
  }

  get alive(): boolean {
    return !this.stopped;
  }

  onExit(listener: (code: number, signal: string) => void): void {
    this.exitListeners.push(listener);
  }

  async promptAndWait(
    message: string,
    options: PromptOptions = {},
  ): Promise<PromptResult> {
    if (!this.alive) {
      throw new Error("Codex session stopped");
    }

    const idleTimeout = options.idleTimeout ?? 300_000;

    if (existsSync(this.outputPath)) {
      unlinkSync(this.outputPath);
    }

    const args = this.buildArgs(message, options.skills ?? []);
    const events: RpcEvent[] = [];
    let lastAgentMessage = "";

    return new Promise<PromptResult>((resolve, reject) => {
      let settled = false;
      const proc = spawn("codex", args, {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_HOME: this.codexHome,
        },
      });

      this.currentProc = proc;

      let timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill("SIGTERM");
        reject(new Error(`Codex prompt timed out after ${idleTimeout}ms of inactivity`));
      }, idleTimeout);

      const resetTimer = () => {
        if (settled) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          proc.kill("SIGTERM");
          reject(new Error(`Codex prompt timed out after ${idleTimeout}ms of inactivity`));
        }, idleTimeout);
      };

      const handleLine = (line: string, stream: "stdout" | "stderr") => {
        if (!line.trim()) return;
        resetTimer();

        const parsed = this.parseJsonLine(line);
        if (!parsed) {
          const logEvent = { type: "log", stream, message: line };
          events.push(logEvent);
          void options.onEvent?.(logEvent);
          return;
        }

        events.push(parsed);
        void options.onEvent?.(parsed);

        if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
          this.threadId = parsed.thread_id;
          writeFileSync(this.threadIdPath, `${this.threadId}\n`, "utf-8");
        }

        const item = parsed.item as Record<string, unknown> | undefined;
        if (
          parsed.type === "item.completed" &&
          item?.type === "agent_message" &&
          typeof item.text === "string"
        ) {
          lastAgentMessage = item.text;
        }
      };

      const bindStream = (stream: NodeJS.ReadableStream | null, name: "stdout" | "stderr") => {
        if (!stream) return;
        let buffer = "";
        stream.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          let idx: number;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            handleLine(line, name);
          }
        });
        stream.on("end", () => {
          if (buffer.trim()) handleLine(buffer, name);
        });
      };

      bindStream(proc.stdout, "stdout");
      bindStream(proc.stderr, "stderr");

      proc.on("error", (err) => {
        this.currentProc = null;
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      });

      proc.on("exit", (code, signal) => {
        this.currentProc = null;
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const normalizedSignal = signal ?? "";

        if (this.stopped) {
          for (const listener of this.exitListeners) {
            listener(code ?? 0, normalizedSignal);
          }
          return reject(new Error("Codex session stopped"));
        }

        const text = this.readOutputFile() || lastAgentMessage.trim();
        if (code === 0) {
          return resolve({ events, text });
        }

        const summary = events
          .filter((event) => event.type === "log" && typeof event.message === "string")
          .slice(-5)
          .map((event) => String(event.message))
          .join("\n");
        reject(new Error(summary || `Codex exited with code ${code ?? "unknown"}`));
      });
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.currentProc && this.currentProc.exitCode === null) {
      this.currentProc.kill("SIGTERM");
    } else {
      for (const listener of this.exitListeners) {
        listener(0, "stopped");
      }
    }
  }

  private buildArgs(message: string, activeSkills: GatewaySkill[]): string[] {
    const prompt = buildCodexPrompt(message, this.options.skills ?? [], activeSkills, this.cwd);
    const args = this.threadId
      ? ["exec", "resume", this.threadId, prompt]
      : ["exec", prompt];

    args.push("--json", "--skip-git-repo-check", "-C", this.cwd, "-o", this.outputPath);

    if (this.options.fullAuto !== false) {
      args.push("--full-auto");
    }
    if (this.options.useOss) {
      args.push("--oss");
    }
    if (this.options.localProvider) {
      args.push("--local-provider", this.options.localProvider);
    }
    if (this.options.model) {
      args.push("--model", this.options.model);
    }

    return args;
  }

  private parseJsonLine(line: string): RpcEvent | null {
    try {
      return JSON.parse(line) as CodexJsonEvent;
    } catch {
      return null;
    }
  }

  private readOutputFile(): string {
    if (!existsSync(this.outputPath)) return "";
    return readFileSync(this.outputPath, "utf-8").trim();
  }
}

export function buildCodexPrompt(
  message: string,
  skills: GatewaySkill[],
  activeSkills: GatewaySkill[],
  cwd = process.cwd(),
): string {
  const soulPrompt = readSoulPrompt(cwd);
  const prompt = [
    "You are Donna running through Codex.",
    "You are chatting with the user through a messaging app like Telegram, WhatsApp, or Discord, so write natural text messages rather than formal reports.",
    "You have access to the user's local machine and repo.",
    soulPrompt,
    "Before searching files or code patterns, check memory first with `donna recall \"...\"`.",
    "After you discover something useful, cache it with `donna remember <donna> \"<key>\" \"<value>\"`.",
    "When the user asks for a reminder or recurring message, write a JSON line into `.gateway/cron/requests.jsonl`.",
    "Use action=add with cron, prompt, oneShot, and timestamp fields; use action=remove to delete a schedule; read `.gateway/cron/jobs.json` to inspect active schedules.",
    "Incoming prompts may include a separate `Structured message context JSON` block with attachments and reply metadata; treat that JSON as authoritative structured context rather than part of the raw message text.",
    "If an attachment object includes a local `path`, that file already exists on disk and you can inspect it with your normal file tools.",
    "If the user explicitly asks you to send a local file and the chat platform supports attachments, include one line per file exactly like `[[attachment:/absolute/path/to/file]]`.",
    "Only use attachment lines for files that already exist on disk, and keep any explanatory text outside those lines.",
    "If a heartbeat asks whether there is anything worth saying and there truly is not, respond with exactly: NOTHING.",
  ].filter(Boolean).join("\n");

  return [
    prompt,
    formatSkillsCatalogForPrompt(
      skills,
      "Use your file or shell tools to inspect a skill file when the task matches its description.",
      "codex",
    ),
    formatInlineSkillsForPrompt(activeSkills, "Active project skills for this request:", "codex"),
    "",
    "User message:",
    message,
  ].join("\n");
}
