import { describe, expect, it } from "vitest";
import {
  ProgressController,
  classifyProgressEvent,
  shouldWaitForUser,
  type ProgressTransport,
} from "../src/gateway/progress.js";

function waitForFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ProgressController", () => {
  it("acknowledges immediately and edits a single status message as work changes", async () => {
    const operations: string[] = [];

    const transport: ProgressTransport = {
      beginTyping: async () => {
        operations.push("typing:start");
      },
      endTyping: async () => {
        operations.push("typing:end");
      },
      addReaction: async (emoji: string) => {
        operations.push(`add:${emoji}`);
      },
      removeReaction: async (emoji: string) => {
        operations.push(`remove:${emoji}`);
      },
      sendStatusMessage: async (text: string) => {
        operations.push(`send:${text}`);
        return "status-1";
      },
      editMessage: async (messageId: string, text: string) => {
        operations.push(`edit:${messageId}:${text}`);
      },
      deleteMessage: async (messageId: string) => {
        operations.push(`delete:${messageId}`);
      },
    };

    const progress = new ProgressController(transport, 0);

    await progress.start();
    expect(operations).toEqual([
      "typing:start",
      "add:👀",
      "send:Looking into it.",
    ]);

    operations.length = 0;
    await progress.researching();
    await waitForFlush();
    expect(operations).toEqual([
      "add:🔎",
      "edit:status-1:Checking the relevant files.",
    ]);

    operations.length = 0;
    await progress.working();
    await waitForFlush();
    expect(operations).toEqual([
      "remove:🔎",
      "add:🛠️",
      "edit:status-1:Applying the fix.",
    ]);

    operations.length = 0;
    await progress.complete();
    expect(operations).toEqual([
      "remove:👀",
      "remove:🛠️",
      "add:✅",
      "delete:status-1",
    ]);

    operations.length = 0;
    await progress.dispose();
    expect(operations).toEqual(["typing:end"]);
  });
});

describe("progress event classification", () => {
  it("recognizes testing work from command events", () => {
    expect(
      classifyProgressEvent({
        type: "item.completed",
        item: { type: "command_execution", command: "npm run typecheck" },
      }),
    ).toBe("testing");
  });

  it("recognizes implementation work from patch events", () => {
    expect(
      classifyProgressEvent({
        type: "tool_call",
        name: "apply_patch",
      }),
    ).toBe("working");
  });
});

describe("waiting for user detection", () => {
  it("detects short clarification prompts", () => {
    expect(shouldWaitForUser("Which option do you want me to use?")).toBe(true);
  });

  it("does not treat normal completion text as waiting", () => {
    expect(shouldWaitForUser("Done. I updated the gateway and tests passed.")).toBe(false);
  });
});
