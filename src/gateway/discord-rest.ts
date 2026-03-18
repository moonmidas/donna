const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/moonmidas/donna, 0.1.0)";
const MAX_RETRIES = 5;

interface QueueEntry {
  tail: Promise<void>;
}

export class DiscordRestClient {
  private readonly queues = new Map<string, QueueEntry>();
  private readonly routeToBucket = new Map<string, string>();
  private readonly bucketResetAt = new Map<string, number>();
  private globalResetAt = 0;

  constructor(private readonly token: string) {}

  request(path: string, init: RequestInit = {}): Promise<Response> {
    const majorKey = extractMajorResourceKey(path);
    return this.enqueue(majorKey, () => this.requestWithRateLimits(path, init));
  }

  private async requestWithRateLimits(path: string, init: RequestInit): Promise<Response> {
    const method = (init.method || "GET").toUpperCase();
    const routeKey = `${method} ${normalizeRateLimitRoute(path)}`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      await this.waitForAvailability(routeKey);

      const headers = new Headers(init.headers || {});
      headers.set("Authorization", `Bot ${this.token}`);
      headers.set("User-Agent", USER_AGENT);

      const response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers,
      });

      const shouldRetry = await this.captureRateLimitState(routeKey, response);
      if (!shouldRetry) {
        return response;
      }
    }

    throw new Error(`Discord request exceeded retry budget for ${method} ${path}`);
  }

  private async captureRateLimitState(routeKey: string, response: Response): Promise<boolean> {
    const now = Date.now();
    const bucketId = response.headers.get("X-RateLimit-Bucket") || response.headers.get("x-ratelimit-bucket");
    const resetAfterHeader = response.headers.get("X-RateLimit-Reset-After")
      || response.headers.get("x-ratelimit-reset-after");
    const remainingHeader = response.headers.get("X-RateLimit-Remaining")
      || response.headers.get("x-ratelimit-remaining");
    const scopeHeader = response.headers.get("X-RateLimit-Scope")
      || response.headers.get("x-ratelimit-scope");
    const majorKey = extractMajorKeyFromRouteKey(routeKey);
    const bucketKey = bucketId ? `${majorKey}:${bucketId}` : routeKey;

    if (bucketId) {
      this.routeToBucket.set(routeKey, bucketKey);
    }

    const resetAfterMs = secondsHeaderToMs(resetAfterHeader);
    if (bucketId && resetAfterMs > 0 && remainingHeader === "0") {
      this.bucketResetAt.set(bucketKey, now + resetAfterMs);
    }

    if (response.status !== 429) {
      return false;
    }

    const payload = await readRateLimitPayload(response);
    const retryAfterMs = Math.max(
      secondsHeaderToMs(response.headers.get("Retry-After") || response.headers.get("retry-after")),
      secondsValueToMs(payload.retryAfter),
      resetAfterMs,
    );
    const resetAt = now + retryAfterMs;

    if (payload.global || scopeHeader === "global") {
      this.globalResetAt = Math.max(this.globalResetAt, resetAt);
    } else {
      this.routeToBucket.set(routeKey, bucketKey);
      this.bucketResetAt.set(bucketKey, resetAt);
    }

    await sleep(retryAfterMs);
    return true;
  }

  private async waitForAvailability(routeKey: string): Promise<void> {
    const waits: number[] = [];
    const now = Date.now();

    if (this.globalResetAt > now) {
      waits.push(this.globalResetAt - now);
    }

    const bucketKey = this.routeToBucket.get(routeKey);
    if (bucketKey) {
      const bucketResetAt = this.bucketResetAt.get(bucketKey) || 0;
      if (bucketResetAt > now) {
        waits.push(bucketResetAt - now);
      }
    }

    if (waits.length > 0) {
      await sleep(Math.max(...waits));
    }
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key)?.tail || Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );

    this.queues.set(key, { tail });
    tail.finally(() => {
      const current = this.queues.get(key);
      if (current?.tail === tail) {
        this.queues.delete(key);
      }
    });

    return run;
  }
}

export function normalizeRateLimitRoute(path: string): string {
  return path
    .replace(/\/messages\/\d+/g, "/messages/:message_id")
    .replace(/\/reactions\/[^/]+\/@me/g, "/reactions/:emoji/@me")
    .replace(/\/reactions\/[^/]+\/\d+/g, "/reactions/:emoji/:user_id");
}

function extractMajorResourceKey(path: string): string {
  const channelMatch = path.match(/^\/channels\/([^/]+)/);
  if (channelMatch) return `channel:${channelMatch[1]}`;

  const guildMatch = path.match(/^\/guilds\/([^/]+)/);
  if (guildMatch) return `guild:${guildMatch[1]}`;

  const webhookMatch = path.match(/^\/webhooks\/([^/]+)(?:\/([^/]+))?/);
  if (webhookMatch) {
    return webhookMatch[2]
      ? `webhook:${webhookMatch[1]}:${webhookMatch[2]}`
      : `webhook:${webhookMatch[1]}`;
  }

  return "global";
}

function extractMajorKeyFromRouteKey(routeKey: string): string {
  const [, path = ""] = routeKey.split(" ", 2);
  return extractMajorResourceKey(path);
}

function secondsHeaderToMs(value: string | null): number {
  if (!value) return 0;
  return secondsValueToMs(Number(value));
}

function secondsValueToMs(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.ceil(numeric * 1000);
}

async function readRateLimitPayload(response: Response): Promise<{
  retryAfter: number;
  global: boolean;
}> {
  try {
    const payload = await response.clone().json() as { retry_after?: number; global?: boolean };
    return {
      retryAfter: typeof payload.retry_after === "number" ? payload.retry_after : 0,
      global: payload.global === true,
    };
  } catch {
    return { retryAfter: 0, global: false };
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
