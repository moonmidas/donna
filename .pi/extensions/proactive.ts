/**
 * Proactive Extension — scheduling plus quiet memory maintenance.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { DonnaShelf, promoteFacts } from "../../src/donna/index.js";

const REQUESTS_FILE = ".gateway/cron/requests.jsonl";

interface ScheduleRequest {
  action: "add" | "remove" | "list";
  id?: string;
  cron?: string;
  prompt?: string;
  oneShot?: boolean;
  timestamp: string;
}

async function writeRequest(
  pi: ExtensionAPI,
  request: ScheduleRequest,
): Promise<{ success: boolean; error?: string }> {
  try {
    const line = JSON.stringify(request);
    const result = await pi.exec("sh", [
      "-c",
      `mkdir -p .gateway/cron && echo '${line.replace(/'/g, "'\\''")}' >> ${REQUESTS_FILE}`,
    ], { timeout: 3000 });
    if (result.code !== 0) {
      return { success: false, error: result.stderr || "Failed to write request" };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function loadShelf(): DonnaShelf {
  const shelf = new DonnaShelf();
  shelf.loadAll();
  shelf.getOrCreate("memory");
  return shelf;
}

const ScheduleParams = Type.Object({
  action: StringEnum(["create", "delete", "list"] as const),
  cron: Type.Optional(Type.String({
    description: 'Cron expression (5-field: min hour dom month dow). Required for "create".',
  })),
  message: Type.Optional(Type.String({
    description: 'The message/prompt to send when the schedule fires. Required for "create".',
  })),
  one_shot: Type.Optional(Type.Boolean({
    description: "If true, fires once then auto-deletes. Default false (recurring).",
  })),
  schedule_id: Type.Optional(Type.String({
    description: 'ID of the schedule to delete. Required for "delete".',
  })),
});

const ReflectParams = Type.Object({
  limit: Type.Optional(Type.Number({
    description: "Maximum notes to inspect. Defaults to 10.",
  })),
});

export default function proactive(pi: ExtensionAPI) {
  pi.registerTool({
    name: "schedule",
    label: "Schedule Message",
    description:
      "Schedule future messages, reminders, or follow-ups. " +
      'Cron format: "minute hour day-of-month month day-of-week".',
    promptSnippet: "schedule: create/delete/list scheduled messages and reminders",
    promptGuidelines: [
      'Use schedule to create reminders when users say "remind me", "check back", "follow up"',
      "Use one_shot=true for one-time reminders, false for recurring",
      "Always confirm with the user what was scheduled",
    ],
    parameters: ScheduleParams,

    async execute(_toolCallId, params) {
      const { action } = params;

      if (action === "create") {
        if (!params.cron || !params.message) {
          return {
            content: [{ type: "text", text: "Error: both 'cron' and 'message' are required for create action." }],
            isError: true,
          };
        }

        const request: ScheduleRequest = {
          action: "add",
          cron: params.cron,
          prompt: params.message,
          oneShot: params.one_shot ?? false,
          timestamp: new Date().toISOString(),
        };

        const { success, error } = await writeRequest(pi, request);
        if (!success) {
          return {
            content: [{ type: "text", text: `Failed to create schedule: ${error}` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text",
            text: `Schedule created: "${params.message}" with cron "${params.cron}"${params.one_shot ? " (one-shot)" : " (recurring)"}`,
          }],
        };
      }

      if (action === "delete") {
        if (!params.schedule_id) {
          return {
            content: [{ type: "text", text: "Error: 'schedule_id' is required for delete action." }],
            isError: true,
          };
        }

        const request: ScheduleRequest = {
          action: "remove",
          id: params.schedule_id,
          timestamp: new Date().toISOString(),
        };

        const { success, error } = await writeRequest(pi, request);
        if (!success) {
          return {
            content: [{ type: "text", text: `Failed to delete schedule: ${error}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `Schedule ${params.schedule_id} deleted.` }],
        };
      }

      if (action === "list") {
        try {
          const result = await pi.exec("cat", [".gateway/cron/jobs.json"], { timeout: 3000 });
          if (result.code !== 0) {
            return { content: [{ type: "text", text: "No schedules found." }] };
          }

          const jobs = JSON.parse(result.stdout);
          if (!Array.isArray(jobs) || jobs.length === 0) {
            return { content: [{ type: "text", text: "No active schedules." }] };
          }

          const visible = jobs.filter((job: any) => !job.hidden);
          if (visible.length === 0) {
            return { content: [{ type: "text", text: "No active schedules." }] };
          }

          const lines = visible.map((job: any) =>
            `- [${job.id}] ${job.cron} -> "${job.prompt}" ${job.oneShot ? "(one-shot)" : "(recurring)"}${job.enabled ? "" : " (disabled)"}`,
          );

          return {
            content: [{ type: "text", text: `Active schedules:\n${lines.join("\n")}` }],
          };
        } catch {
          return { content: [{ type: "text", text: "No schedules found." }] };
        }
      }

      return {
        content: [{ type: "text", text: `Unknown action: ${action}` }],
        isError: true,
      };
    },
  });

  pi.registerTool({
    name: "reflectAndCleanMemory",
    label: "Reflect And Clean Memory",
    description:
      "Run a safe maintenance pass over the Donna note graph. " +
      "It rewrites stale notes, merges near-duplicates, improves tags and links, and archives low-value notes.",
    promptSnippet: "reflectAndCleanMemory: run a safe daily memory cleanup pass",
    promptGuidelines: [
      "Use this after important work or when proactive maintenance asks for it",
      "It inspects at most 10 notes by default",
      "Prefer this over ad-hoc note cleanup",
    ],
    parameters: ReflectParams,

    async execute(_toolCallId, params) {
      const shelf = loadShelf();
      const summary = shelf.reflectAndCleanMemory("memory", params.limit ?? 10);
      shelf.saveAll();
      try {
        promoteFacts(shelf);
      } catch {
        // Promotion is best-effort only.
      }

      const headline =
        `Memory cleanup complete: inspected ${summary.inspected}, ` +
        `rewrote ${summary.rewritten}, merged ${summary.merged}, ` +
        `hid ${summary.hidden}, tagged ${summary.tagged}, linked ${summary.linked}.`;
      const details = summary.changes
        .slice(0, 8)
        .map((change) => `- [${change.noteId}] ${change.type}: ${change.detail}`)
        .join("\n");

      return {
        content: [{ type: "text", text: details ? `${headline}\n${details}` : headline }],
      };
    },
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + `\n\n## Proactive Capabilities

You can schedule future messages and reminders using the \`schedule\` tool.
You can maintain your memory graph with \`reflectAndCleanMemory\`.

When a user says "remind me", "check back later", or "follow up", use the schedule tool.
When a proactive maintenance prompt asks you to clean memory, run \`reflectAndCleanMemory\` and reply with exactly NOTHING unless there is something the user really needs to hear.`,
    };
  });
}
