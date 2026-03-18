import { describe, expect, it, vi } from "vitest";

const startMock = vi.fn();
const onMock = vi.fn();
const catchMock = vi.fn();
const stopMock = vi.fn();
const sendMessageMock = vi.fn();

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: onMock,
    catch: catchMock,
    start: startMock,
    stop: stopMock,
    api: {
      sendMessage: sendMessageMock,
    },
  })),
}));

import { connectTelegram } from "../src/gateway/telegram.js";

describe("telegram polling", () => {
  it("does not drop pending updates when reconnecting", () => {
    connectTelegram("test-token", async () => {});

    expect(startMock).toHaveBeenCalledTimes(1);

    const options = startMock.mock.calls[0]?.[0];
    expect(options?.drop_pending_updates).not.toBe(true);
  });
});
