import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";
import {
  AGENT_BACKEND,
  AGENT_PROVIDER,
  AGENT_MODEL,
  AGENT_SKILL_PATHS,
  CODEX_FULL_AUTO,
  CODEX_LOCAL_PROVIDER,
  CODEX_USE_OSS,
  LOCAL_MODEL_API_KEY,
  LOCAL_MODEL_BASE_URL,
  LOCAL_MODEL_PROVIDER,
  MAX_PI_PROCESSES,
  PI_IDLE_TIMEOUT_MS,
  PROJECT_ROOT,
  SESSIONS_DIR,
  jidHash,
} from "./config.js";
import type { AgentSession } from "./agent-session.js";
import { CodexRpc } from "./codex-rpc.js";
import { LocalModelRpc } from "./local-model-rpc.js";
import { PiRpc } from "./pi-rpc.js";
import { loadGatewaySkills, type GatewaySkill } from "./skills.js";

const log = pino({ name: "agent-pool" });

interface SessionEntry {
  jid: string;
  rpc: AgentSession;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActive: number;
}

export class AgentPool {
  private sessions = new Map<string, SessionEntry>();
  private loadedSkills: GatewaySkill[] | null = null;

  getOrCreate(jid: string): AgentSession {
    let session = this.sessions.get(jid);

    if (session && session.rpc.alive) {
      return session.rpc;
    }

    if (session) {
      this.sessions.delete(jid);
    }

    if (this.sessions.size >= MAX_PI_PROCESSES) {
      this.evictOldestIdle();
    }

    const sessionDir = resolve(SESSIONS_DIR, jidHash(jid));
    mkdirSync(sessionDir, { recursive: true });

    const rpc = this.createSession(sessionDir);
    rpc.onExit((code: number, signal: string) => {
      log.info({ jid, code, signal, backend: AGENT_BACKEND }, "Agent session exited");
      const current = this.sessions.get(jid);
      if (current?.idleTimer) clearTimeout(current.idleTimer);
      this.sessions.delete(jid);
    });

    if (rpc instanceof PiRpc) {
      rpc.start();
      log.info({ jid, sessionDir, backend: AGENT_BACKEND }, "Pi process started");
    }

    session = { jid, rpc, idleTimer: null, lastActive: Date.now() };
    this.sessions.set(jid, session);
    log.info({ jid, sessionDir, backend: AGENT_BACKEND }, "Agent session ready");

    return rpc;
  }

  markBusy(jid: string): void {
    const session = this.sessions.get(jid);
    if (!session) return;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    session.lastActive = Date.now();
  }

  markIdle(jid: string): void {
    const session = this.sessions.get(jid);
    if (!session) return;
    session.lastActive = Date.now();
    session.idleTimer = setTimeout(() => {
      log.info({ jid, backend: AGENT_BACKEND }, "Idle timeout — stopping agent session");
      session.rpc.stop();
      this.sessions.delete(jid);
    }, PI_IDLE_TIMEOUT_MS);
  }

  kill(jid: string): void {
    const session = this.sessions.get(jid);
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.rpc.stop();
    this.sessions.delete(jid);
    log.info({ jid, backend: AGENT_BACKEND }, "Agent session killed (error recovery)");
  }

  stopAll(): void {
    for (const [jid, session] of this.sessions) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.rpc.stop();
      log.info({ jid, backend: AGENT_BACKEND }, "Agent session stopped (shutdown)");
    }
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }

  getSkills(): GatewaySkill[] {
    return this.getLoadedSkills();
  }

  getSessionDir(jid: string): string {
    const sessionDir = resolve(SESSIONS_DIR, jidHash(jid));
    mkdirSync(sessionDir, { recursive: true });
    return sessionDir;
  }

  private createSession(sessionDir: string): AgentSession {
    const skills = this.getLoadedSkills();

    switch (AGENT_BACKEND) {
      case "codex":
        return new CodexRpc(sessionDir, PROJECT_ROOT, {
          model: AGENT_MODEL || undefined,
          useOss: CODEX_USE_OSS,
          localProvider: CODEX_LOCAL_PROVIDER || undefined,
          fullAuto: CODEX_FULL_AUTO,
          skills,
        });
      case "local":
        return new LocalModelRpc(sessionDir, {
          provider: LOCAL_MODEL_PROVIDER,
          model: AGENT_MODEL,
          baseUrl: LOCAL_MODEL_BASE_URL,
          apiKey: LOCAL_MODEL_API_KEY,
          skills,
        });
      case "pi":
      default:
        return new PiRpc(
          sessionDir,
          PROJECT_ROOT,
          AGENT_PROVIDER,
          AGENT_MODEL || undefined,
          skills,
        );
    }
  }

  private getLoadedSkills(): GatewaySkill[] {
    if (this.loadedSkills) {
      return this.loadedSkills;
    }

    const result = loadGatewaySkills({
      cwd: PROJECT_ROOT,
      skillPaths: AGENT_SKILL_PATHS,
    });

    for (const warning of result.warnings) {
      log.warn({ warning }, "Skill discovery warning");
    }

    this.loadedSkills = result.skills;
    log.info({ count: result.skills.length }, "Gateway skills loaded");
    return this.loadedSkills;
  }

  private evictOldestIdle(): void {
    let oldest: SessionEntry | null = null;

    for (const session of this.sessions.values()) {
      if (session.idleTimer && (!oldest || session.lastActive < oldest.lastActive)) {
        oldest = session;
      }
    }

    if (!oldest) {
      for (const session of this.sessions.values()) {
        if (!oldest || session.lastActive < oldest.lastActive) {
          oldest = session;
        }
      }
    }

    if (oldest) {
      log.info({ jid: oldest.jid, backend: AGENT_BACKEND }, "Evicting session (max processes)");
      if (oldest.idleTimer) clearTimeout(oldest.idleTimer);
      oldest.rpc.stop();
      this.sessions.delete(oldest.jid);
    }
  }
}
