import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../types";

type LimiterBinding = "AUTH_RATE_LIMITER" | "WRITE_RATE_LIMITER";

export function rateLimitMutations(
  binding: LimiterBinding,
  scope: string,
  methods: string[],
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (methods.includes(c.req.method) && !(await consume(c.env[binding], scope, c.req.header("CF-Connecting-IP")))) {
      const error = scope === "auth"
        ? "Too many authentication attempts. Try again shortly."
        : "Too many changes. Try again shortly.";
      return c.json({ error }, 429);
    }
    await next();
  };
}

async function consume(limiter: RateLimit, scope: string, ip: string | undefined) {
  try {
    return (await limiter.limit({ key: `${scope}:${ip ?? "local"}` })).success;
  } catch (error) {
    // Availability wins over abuse protection if Cloudflare's limiter is unavailable.
    console.error("Rate limiter unavailable", error);
    return true;
  }
}
