import { describe, expect, it, vi, afterEach } from "vitest";
import { DiscordRestClient, normalizeRateLimitRoute } from "../src/gateway/discord-rest.js";

describe("normalizeRateLimitRoute", () => {
  it("normalizes message and reaction identifiers while keeping the major resource", () => {
    expect(
      normalizeRateLimitRoute("/channels/123/messages/456/reactions/%F0%9F%A7%A0/@me"),
    ).toBe("/channels/123/messages/:message_id/reactions/:emoji/@me");
  });
});

describe("DiscordRestClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a 429 using Discord retry_after payloads", async () => {
    const responses = [
      new Response(JSON.stringify({
        message: "You are being rate limited.",
        retry_after: 0.01,
        global: false,
      }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Bucket": "bucket-1",
          "X-RateLimit-Reset-After": "0.01",
        },
      }),
      new Response(null, {
        status: 204,
        headers: {
          "X-RateLimit-Bucket": "bucket-1",
          "X-RateLimit-Remaining": "1",
          "X-RateLimit-Reset-After": "0.01",
        },
      }),
    ];

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => responses.shift()!);

    const client = new DiscordRestClient("token");
    const response = await client.request(
      "/channels/123/messages/456/reactions/%F0%9F%A7%A0/@me",
      { method: "PUT" },
    );

    expect(response.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
