import pino from "pino";
import { AgentPool } from "./agent-pool.js";
import { EventQueue, type ProactiveEvent } from "./event-queue.js";
import { HeartbeatManager } from "./heartbeat.js";
import { formatIncomingMessageForAgent, type IncomingMessage } from "./incoming-message.js";
import { parseOutboundMessage, type SendFn } from "./messages.js";
import { shouldWaitForUser } from "./progress.js";
import { resolveSkillsForEvent, resolveSkillsForMessage } from "./skills.js";

const log = pino({ name: "router" });

/** Per-JID message queue to serialize concurrent messages */
const queues = new Map<string, Promise<void>>();

function enqueue(jid: string, fn: () => Promise<void>): void {
  const prev = queues.get(jid) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run even if previous failed
  queues.set(jid, next);
  next.then(() => {
    // Clean up if this was the last in the queue
    if (queues.get(jid) === next) queues.delete(jid);
  });
}

export function createRouter(
  getSend: () => SendFn,
  pool: AgentPool,
  eventQueue: EventQueue,
  heartbeat: HeartbeatManager,
) {
  // Subscribe to proactive events from cron/heartbeat/timers
  eventQueue.on("event", (event: ProactiveEvent) => {
    enqueue(event.jid, () =>
      handleProactiveEvent(getSend(), pool, event),
    );
  });

  return async (message: IncomingMessage): Promise<void> => {
    const { conversationId, text } = message;
    // Touch heartbeat on every incoming message
    heartbeat.register(conversationId);
    enqueue(conversationId, () => handleMessage(getSend(), pool, message));
  };
}

async function handleMessage(
  send: SendFn,
  pool: AgentPool,
  message: IncomingMessage,
): Promise<void> {
  const jid = message.conversationId;
  const progress = message.progress;

  try {
    await progress?.thinking();

    const skillResolution = resolveSkillsForMessage(
      pool.getSkills(),
      pool.getSessionDir(jid),
      message.text,
    );
    if (skillResolution.command.handled) {
      await progress?.packaging();
      await send(jid, parseOutboundMessage(skillResolution.command.response || "Skill command handled."));
      await progress?.complete();
      return;
    }

    const rpc = pool.getOrCreate(jid);
    pool.markBusy(jid);

    const result = await rpc.promptAndWait(formatIncomingMessageForAgent(message), {
      skills: skillResolution.activeSkills,
      onEvent: (event) => progress?.observe(event),
    });
    let response = result.text.trim();

    if (!response) {
      // Fallback: look for text in agent_end or message events
      for (const event of result.events) {
        if (typeof event.message === "string" && event.message.trim()) {
          response = event.message.trim();
          break;
        }
      }
    }

    if (!response) {
      response = "(No response from agent)";
    }

    await progress?.packaging();
    await send(jid, parseOutboundMessage(response));
    if (shouldWaitForUser(response)) {
      await progress?.waitingForUser();
    } else {
      await progress?.complete();
    }

    log.info({ jid, responseLen: response.length }, "Reply sent");
  } catch (err) {
    log.error({ jid, err }, "Error handling message");
    pool.kill(jid);
    const errorText = err instanceof Error ? err.message : "";
    if (/permission|forbidden|unauthorized|auth/i.test(errorText)) {
      await progress?.waitingOnPermission();
    } else {
      await progress?.fail();
    }
    try {
      await send(jid, { text: "Sorry, something went wrong. Please try again." });
    } catch (sendErr) {
      log.error({ jid, sendErr }, "Failed to send error message");
    }
  } finally {
    await progress?.dispose();
    pool.markIdle(jid);
  }
}

async function handleProactiveEvent(
  send: SendFn,
  pool: AgentPool,
  event: ProactiveEvent,
): Promise<void> {
  try {
    let rpc = pool.getOrCreate(event.jid);
    pool.markBusy(event.jid);
    const activeSkills = resolveSkillsForEvent(
      pool.getSkills(),
      pool.getSessionDir(event.jid),
    );

    let result = await rpc.promptAndWait(event.prompt, { skills: activeSkills });
    let response = result.text.trim();

    if (isTransientPiTerminationResponse(response)) {
      log.warn({ jid: event.jid, type: event.type }, "Transient Pi termination during proactive event — retrying once");
      pool.kill(event.jid);
      rpc = pool.getOrCreate(event.jid);
      pool.markBusy(event.jid);
      result = await rpc.promptAndWait(event.prompt, { skills: activeSkills });
      response = result.text.trim();
    }

    // Heartbeats and maintenance runs are silent unless they have something real to surface.
    if (event.type === "heartbeat" || event.type === "maintenance") {
      if (isInternalAgentErrorResponse(response)) {
        log.warn(
          { jid: event.jid, type: event.type, response },
          "Suppressing internal agent error during proactive event",
        );
        return;
      }
      if (!response || response.toUpperCase().includes("NOTHING")) {
        log.info({ jid: event.jid, type: event.type }, "Proactive event — nothing to say");
        return;
      }
    }

    if (!response) {
      log.info({ jid: event.jid, type: event.type }, "Proactive event — no response");
      return;
    }

    await send(event.jid, parseOutboundMessage(response));

    log.info({ jid: event.jid, type: event.type, responseLen: response.length }, "Proactive reply sent");
  } catch (err) {
    log.error({ jid: event.jid, type: event.type, err }, "Error handling proactive event");
  } finally {
    pool.markIdle(event.jid);
  }
}

function isTransientPiTerminationResponse(response: string): boolean {
  const normalized = response.trim().toLowerCase();
  return normalized === "pi error: terminated" || normalized === "error: terminated";
}

function isInternalAgentErrorResponse(response: string): boolean {
  const normalized = response.trim().toLowerCase();
  return normalized.startsWith("pi error:") || normalized.startsWith("error: ");
}
