import pino from "pino";
import {
  HEARTBEAT_INTERVAL_MS,
  MEMORY_REFLECTION_HOUR,
  MEMORY_REFLECTION_MAX_NOTES,
  MEMORY_REFLECTION_MINUTE,
  QUIET_HOURS_END,
  QUIET_HOURS_START,
} from "./config.js";
import { EventQueue } from "./event-queue.js";

const log = pino({ name: "heartbeat" });

const HEARTBEAT_PROMPT = `It's been a while since you last interacted with the user. Check your memory — is there anything you should follow up on, remind the user about, or proactively share? Consider:
- Pending tasks or reminders
- Things the user asked you to check on later
- Useful information you've discovered since last time

If there's something worth saying, write a natural message to the user. If there's truly nothing to follow up on, respond with exactly: NOTHING`;

const MEMORY_REFLECTION_PROMPT = `Run reflectAndCleanMemory() to maintain your Zettelkasten memory graph. Inspect up to ${MEMORY_REFLECTION_MAX_NOTES} notes, safely rewrite stale notes, merge near-duplicates, improve tags and links, and clean low-value notes. Reply with exactly NOTHING unless the cleanup surfaced something the user truly needs to know right now.`;

interface UserHeartbeat {
  jid: string;
  timer: ReturnType<typeof setInterval> | null;
  lastInteraction: number;
  lastReflectionAt: number;
}

export class HeartbeatManager {
  private users = new Map<string, UserHeartbeat>();

  constructor(private queue: EventQueue) {}

  register(jid: string): void {
    if (this.users.has(jid)) {
      this.touch(jid);
      return;
    }

    const hb: UserHeartbeat = {
      jid,
      timer: null,
      lastInteraction: Date.now(),
      lastReflectionAt: 0,
    };

    this.users.set(jid, hb);
    this.startTimer(hb);
    log.info({ jid }, "Heartbeat registered");
  }

  touch(jid: string): void {
    const hb = this.users.get(jid);
    if (!hb) return;
    hb.lastInteraction = Date.now();
    this.stopTimer(hb);
    this.startTimer(hb);
  }

  unregister(jid: string): void {
    const hb = this.users.get(jid);
    if (!hb) return;
    this.stopTimer(hb);
    this.users.delete(jid);
  }

  stopAll(): void {
    for (const hb of this.users.values()) {
      this.stopTimer(hb);
    }
    this.users.clear();
  }

  private startTimer(hb: UserHeartbeat): void {
    if (HEARTBEAT_INTERVAL_MS <= 0) return;
    hb.timer = setInterval(() => this.fire(hb), HEARTBEAT_INTERVAL_MS);
  }

  private stopTimer(hb: UserHeartbeat): void {
    if (!hb.timer) return;
    clearInterval(hb.timer);
    hb.timer = null;
  }

  private fire(hb: UserHeartbeat): void {
    if (isQuietHours()) {
      log.debug({ jid: hb.jid }, "Skipping heartbeat — quiet hours");
      return;
    }

    const timeSinceActive = Date.now() - hb.lastInteraction;
    if (timeSinceActive < HEARTBEAT_INTERVAL_MS / 2) {
      log.debug({ jid: hb.jid }, "Skipping heartbeat — user recently active");
      return;
    }

    if (shouldQueueReflection(hb)) {
      hb.lastReflectionAt = Date.now();
      log.info({ jid: hb.jid }, "Queueing daily memory reflection");
      this.queue.push({
        type: "maintenance",
        jid: hb.jid,
        prompt: MEMORY_REFLECTION_PROMPT,
      });
      return;
    }

    log.info({ jid: hb.jid }, "Heartbeat firing");
    this.queue.push({
      type: "heartbeat",
      jid: hb.jid,
      prompt: HEARTBEAT_PROMPT,
    });
  }
}

function isQuietHours(): boolean {
  if (QUIET_HOURS_START < 0 || QUIET_HOURS_END < 0) return false;

  const hour = new Date().getHours();
  if (QUIET_HOURS_START > QUIET_HOURS_END) {
    return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
  }
  return hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
}

function shouldQueueReflection(hb: UserHeartbeat): boolean {
  const now = new Date();
  const passedWindow =
    now.getHours() > MEMORY_REFLECTION_HOUR ||
    (now.getHours() === MEMORY_REFLECTION_HOUR && now.getMinutes() >= MEMORY_REFLECTION_MINUTE);
  if (!passedWindow) return false;

  if (!hb.lastReflectionAt) return true;

  const last = new Date(hb.lastReflectionAt);
  const sameDay = last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getDate() === now.getDate();
  if (sameDay) return false;

  return now.getTime() - hb.lastReflectionAt >= 24 * 60 * 60 * 1000;
}
