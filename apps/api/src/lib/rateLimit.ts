import type { Redis } from "ioredis";

export interface LimitResult {
  ok: boolean;
  /** Seconds until the window resets (when !ok). */
  retryAfter: number;
}

/** Fixed-window counters. Simple, cheap, and good enough to stop floods and runaway bills. */
export interface RateLimiter {
  hit(key: string, limit: number, windowSeconds: number): Promise<LimitResult>;
}

export function redisRateLimiter(redis: Redis, prefix = "lumen:rl:"): RateLimiter {
  return {
    async hit(key, limit, windowSeconds) {
      const window = Math.floor(Date.now() / 1000 / windowSeconds);
      const k = `${prefix}${key}:${window}`;
      const [[, count]] = (await redis
        .multi()
        .incr(k)
        .expire(k, windowSeconds + 5)
        .exec()) as [[unknown, number]];
      return {
        ok: count <= limit,
        retryAfter: windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds),
      };
    },
  };
}

/** In-process limiter for tests and single-instance setups without Redis. */
export function memoryRateLimiter(): RateLimiter {
  const counts = new Map<string, number>();
  return {
    async hit(key, limit, windowSeconds) {
      const window = Math.floor(Date.now() / 1000 / windowSeconds);
      const k = `${key}:${window}`;
      const count = (counts.get(k) ?? 0) + 1;
      counts.set(k, count);
      return {
        ok: count <= limit,
        retryAfter: windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds),
      };
    },
  };
}

export interface WidgetLimits {
  sessionsPerIpPerMinute: number;
  messagesPerVisitorPerMinute: number;
  messagesPerVisitorPerDay: number;
  messagesPerBotPerMinute: number;
}

export const DEFAULT_WIDGET_LIMITS: WidgetLimits = {
  sessionsPerIpPerMinute: 30,
  messagesPerVisitorPerMinute: 10,
  messagesPerVisitorPerDay: 200,
  messagesPerBotPerMinute: 120,
};

/** Monthly answer counter per bot, seeded from Postgres when Redis has no value. */
export interface MonthlyCounter {
  /** Current count (after seeding); increments when `increment` is true. */
  get(botId: string, seed: () => Promise<number>, increment: boolean): Promise<number>;
}

const monthKey = () => new Date().toISOString().slice(0, 7);

export function redisMonthlyCounter(redis: Redis, prefix = "lumen:month:"): MonthlyCounter {
  return {
    async get(botId, seed, increment) {
      const k = `${prefix}${botId}:${monthKey()}`;
      if ((await redis.exists(k)) === 0) await redis.set(k, String(await seed()), "EX", 40 * 86_400, "NX");
      return increment ? redis.incr(k) : Number((await redis.get(k)) ?? 0);
    },
  };
}

export function memoryMonthlyCounter(): MonthlyCounter {
  const counts = new Map<string, number>();
  return {
    async get(botId, seed, increment) {
      const k = `${botId}:${monthKey()}`;
      if (!counts.has(k)) counts.set(k, await seed());
      const n = (counts.get(k) ?? 0) + (increment ? 1 : 0);
      counts.set(k, n);
      return n;
    },
  };
}
