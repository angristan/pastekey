import { Cause, Effect } from "effect";
import type { MiddlewareHandler } from "hono";

import { RateLimiter, type RateLimiterBindingName } from "../platform/cloudflare";
import { runWorkerEffect } from "../runtime";
import type { AppEnv } from "../types";

export function rateLimitMutations(
  binding: RateLimiterBindingName,
  scope: string,
  methods: string[],
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (
      methods.includes(c.req.method) &&
      !(await runWorkerEffect(
        c.env,
        consumeRateLimit(binding, scope, c.req.header("CF-Connecting-IP")),
      ))
    ) {
      const error = scope === "auth"
        ? "Too many authentication attempts. Try again shortly."
        : "Too many changes. Try again shortly.";
      return c.json({ error }, 429);
    }
    await next();
  };
}

const consumeRateLimit = Effect.fn("RateLimit.consume")(function* (
  binding: RateLimiterBindingName,
  scope: string,
  ip: string | undefined,
) {
  const limiter = yield* RateLimiter;
  return yield* limiter.limit(binding, { key: `${scope}:${ip ?? "local"}` }).pipe(
    Effect.map((result) => result.success),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        // Availability wins over abuse protection if Cloudflare's limiter is unavailable.
        console.error("Rate limiter unavailable", Cause.squash(cause));
        return true;
      })
    ),
  );
});
