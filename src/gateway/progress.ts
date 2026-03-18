import pino from "pino";
import type { RpcEvent } from "./agent-session.js";

const log = pino({ name: "progress" });
const DEFAULT_DEBOUNCE_MS = 350;

export interface ProgressTransport {
  addReaction?: (emoji: string) => Promise<void>;
  removeReaction?: (emoji: string) => Promise<void>;
  sendStatusMessage?: (text: string) => Promise<string>;
  editMessage?: (messageId: string, text: string) => Promise<void>;
  deleteMessage?: (messageId: string) => Promise<void>;
  beginTyping?: () => Promise<void>;
  endTyping?: () => Promise<void>;
}

interface ProgressSnapshot {
  acknowledgment?: string;
  cognition?: string;
  workMode?: string;
  waiting?: string;
  outcome?: string;
  heartbeat?: string;
}

type ProgressPhase =
  | "seen"
  | "thinking"
  | "researching"
  | "reading"
  | "working"
  | "testing"
  | "running"
  | "browsing"
  | "drafting"
  | "packaging"
  | "waiting_for_user"
  | "waiting_on_permission"
  | "completed"
  | "failed";

interface PhaseDescriptor {
  snapshot: ProgressSnapshot;
  status: string;
}

const ACK = "👀";

const PHASES: Record<ProgressPhase, PhaseDescriptor> = {
  seen: {
    snapshot: { acknowledgment: ACK },
    status: "Looking into it.",
  },
  thinking: {
    snapshot: { acknowledgment: ACK, cognition: "🧠" },
    status: "Thinking it through.",
  },
  researching: {
    snapshot: { acknowledgment: ACK, workMode: "🔎" },
    status: "Checking the relevant files.",
  },
  reading: {
    snapshot: { acknowledgment: ACK, workMode: "📚" },
    status: "Reading the relevant context.",
  },
  working: {
    snapshot: { acknowledgment: ACK, workMode: "🛠️" },
    status: "Applying the fix.",
  },
  testing: {
    snapshot: { acknowledgment: ACK, workMode: "🧪" },
    status: "Testing the changes.",
  },
  running: {
    snapshot: { acknowledgment: ACK, workMode: "🖥️" },
    status: "Running a command.",
  },
  browsing: {
    snapshot: { acknowledgment: ACK, workMode: "🌐" },
    status: "Looking it up.",
  },
  drafting: {
    snapshot: { acknowledgment: ACK, workMode: "📝" },
    status: "Drafting the reply.",
  },
  packaging: {
    snapshot: { acknowledgment: ACK, workMode: "📦" },
    status: "Preparing the reply.",
  },
  waiting_for_user: {
    snapshot: { waiting: "❓" },
    status: "Waiting on one detail from you.",
  },
  waiting_on_permission: {
    snapshot: { waiting: "🔐" },
    status: "Waiting on permission.",
  },
  completed: {
    snapshot: { outcome: "✅" },
    status: "Done.",
  },
  failed: {
    snapshot: { outcome: "⚠️" },
    status: "Hit a problem.",
  },
};

const SNAPSHOT_CATEGORIES: Array<keyof ProgressSnapshot> = [
  "acknowledgment",
  "cognition",
  "workMode",
  "waiting",
  "outcome",
  "heartbeat",
];

export class ProgressController {
  private desired = PHASES.seen.snapshot;
  private applied: ProgressSnapshot = {};
  private desiredStatus = PHASES.seen.status;
  private appliedStatus = "";
  private statusMessageId = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private closed = false;
  private currentPhase: ProgressPhase = "seen";
  private deleteStatusAfterFlush = false;

  constructor(
    private readonly transport: ProgressTransport,
    private readonly debounceMs = DEFAULT_DEBOUNCE_MS,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.transport.beginTyping) {
      await this.safeRun("begin typing", () => this.transport.beginTyping!());
    }

    await this.applyPhase("seen", { immediate: true });
  }

  async thinking(): Promise<void> {
    await this.applyPhase("thinking");
  }

  async researching(): Promise<void> {
    await this.applyPhase("researching");
  }

  async reading(): Promise<void> {
    await this.applyPhase("reading");
  }

  async working(): Promise<void> {
    await this.applyPhase("working");
  }

  async testing(): Promise<void> {
    await this.applyPhase("testing");
  }

  async running(): Promise<void> {
    await this.applyPhase("running");
  }

  async browsing(): Promise<void> {
    await this.applyPhase("browsing");
  }

  async drafting(): Promise<void> {
    await this.applyPhase("drafting");
  }

  async packaging(): Promise<void> {
    await this.applyPhase("packaging");
  }

  async waitingForUser(): Promise<void> {
    await this.applyPhase("waiting_for_user");
  }

  async waitingOnPermission(): Promise<void> {
    await this.applyPhase("waiting_on_permission");
  }

  async complete(): Promise<void> {
    await this.applyPhase("completed", { immediate: true, deleteStatus: true });
  }

  async fail(message?: string): Promise<void> {
    await this.applyPhase("failed", { immediate: true, status: message || PHASES.failed.status });
  }

  async observe(event: RpcEvent): Promise<void> {
    const nextPhase = classifyProgressEvent(event);
    if (!nextPhase || nextPhase === this.currentPhase) return;
    await this.applyPhase(nextPhase);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();

    if (this.transport.endTyping) {
      await this.safeRun("end typing", () => this.transport.endTyping!());
    }
  }

  private async applyPhase(
    phase: ProgressPhase,
    options: { immediate?: boolean; status?: string; deleteStatus?: boolean } = {},
  ): Promise<void> {
    this.currentPhase = phase;
    this.desired = { ...PHASES[phase].snapshot };
    this.desiredStatus = options.status || PHASES[phase].status;
    this.deleteStatusAfterFlush = options.deleteStatus ?? false;

    if (options.immediate) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      await this.flush();
      return;
    }

    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    const staleEmojis: string[] = [];
    const nextEmojis: string[] = [];

    for (const category of SNAPSHOT_CATEGORIES) {
      const previous = this.applied[category];
      const next = this.desired[category];
      if (previous && previous !== next) {
        staleEmojis.push(previous);
      }
      if (next && previous !== next) {
        nextEmojis.push(next);
      }
    }

    for (const emoji of staleEmojis) {
      if (!this.transport.removeReaction) break;
      await this.safeRun(`remove reaction ${emoji}`, () => this.transport.removeReaction!(emoji));
    }

    for (const emoji of nextEmojis) {
      if (!this.transport.addReaction) break;
      await this.safeRun(`add reaction ${emoji}`, () => this.transport.addReaction!(emoji));
    }

    this.applied = { ...this.desired };

    if (!this.transport.sendStatusMessage) {
      return;
    }

    if (this.deleteStatusAfterFlush) {
      if (this.statusMessageId && this.transport.deleteMessage) {
        await this.safeRun("delete status message", () =>
          this.transport.deleteMessage!(this.statusMessageId),
        );
        this.statusMessageId = "";
        this.appliedStatus = "";
      }
      return;
    }

    if (!this.statusMessageId) {
      const messageId = await this.safeRun("send status message", () =>
        this.transport.sendStatusMessage!(this.desiredStatus),
      );
      if (typeof messageId === "string" && messageId) {
        this.statusMessageId = messageId;
        this.appliedStatus = this.desiredStatus;
      }
      return;
    }

    if (this.desiredStatus === this.appliedStatus) {
      return;
    }

    if (!this.transport.editMessage) {
      return;
    }

    await this.safeRun("edit status message", () =>
      this.transport.editMessage!(this.statusMessageId, this.desiredStatus),
    );
    this.appliedStatus = this.desiredStatus;
  }

  private async safeRun<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      log.warn({ err, label }, "Progress update failed");
      return undefined;
    }
  }
}

export function classifyProgressEvent(event: RpcEvent): ProgressPhase | null {
  const haystack = safeEventString(event);
  if (!haystack) return null;

  if (hasAny(haystack, ["permission denied", "forbidden", "unauthorized", "auth"])) {
    return "waiting_on_permission";
  }

  if (
    hasAny(haystack, [
      "vitest",
      "jest",
      "mocha",
      "ava",
      "pytest",
      "cargo test",
      "go test",
      "npm test",
      "pnpm test",
      "yarn test",
      "typecheck",
      "tsc",
      "eslint",
      "lint",
    ])
  ) {
    return "testing";
  }

  if (
    hasAny(haystack, [
      "apply_patch",
      "write_file",
      "replace",
      "rewrite",
      "implement",
      "fix",
      "code edit",
      "updated file",
      "created file",
    ])
  ) {
    return "working";
  }

  if (
    hasAny(haystack, [
      "search",
      "grep",
      "rg ",
      "ripgrep",
      "find ",
      "sed ",
      "cat ",
      "read_file",
      "open_file",
      "docs",
      "documentation",
      "inspect",
      "investigate",
    ])
  ) {
    return haystack.includes("read") ? "reading" : "researching";
  }

  if (hasAny(haystack, ["browser", "browse", "web", "url", "http"])) {
    return "browsing";
  }

  if (hasAny(haystack, ["command", "shell", "exec", "terminal"])) {
    return "running";
  }

  if (hasAny(haystack, ["message_update", "agent_message", "draft", "writing"])) {
    return "drafting";
  }

  if (hasAny(haystack, ["reason", "thinking", "plan", "\"response\""])) {
    return "thinking";
  }

  return null;
}

export function shouldWaitForUser(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (!normalized.includes("?")) return false;
  return hasAny(normalized, [
    "can you",
    "could you",
    "would you",
    "which",
    "what",
    "when",
    "where",
    "do you want",
    "i need",
    "please share",
  ]);
}

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function safeEventString(event: RpcEvent): string {
  try {
    return JSON.stringify(event).toLowerCase();
  } catch {
    return "";
  }
}
