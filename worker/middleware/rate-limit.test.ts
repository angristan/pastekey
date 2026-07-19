import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppEnv, Bindings } from "../types";
import { rateLimitMutations } from "./rate-limit";

function isBindings(value: unknown): value is Bindings {
  return typeof value === "object" && value !== null;
}

if (!isBindings(env)) throw new Error("Cloudflare test bindings are unavailable");
const bindings = env;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rate-limit middleware", () => {
  it("uses the selected limiter and preserves the rejection response", async () => {
    const authLimit = vi.fn(() => Promise.resolve({ success: true }));
    const writeLimit = vi.fn(() => Promise.resolve({ success: false }));
    const response = await mutationApp().fetch(
      new Request("https://paste.test/mutation", {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.9" },
      }),
      {
        ...bindings,
        AUTH_RATE_LIMITER: { limit: authLimit },
        WRITE_RATE_LIMITER: { limit: writeLimit },
      },
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "Too many changes. Try again shortly.",
    });
    expect(writeLimit).toHaveBeenCalledWith({ key: "write:203.0.113.9" });
    expect(authLimit).not.toHaveBeenCalled();
  });

  it("fails open when the selected limiter is unavailable", async () => {
    const cause = new Error("limiter unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await mutationApp().fetch(
      new Request("https://paste.test/mutation", { method: "POST" }),
      {
        ...bindings,
        AUTH_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
        WRITE_RATE_LIMITER: { limit: () => Promise.reject(cause) },
      },
    );

    expect(response.status).toBe(204);
    expect(consoleError).toHaveBeenCalledWith(
      "Rate limiter unavailable",
      expect.objectContaining({ _tag: "RateLimiterError", cause }),
    );
  });
});

function mutationApp() {
  const app = new Hono<AppEnv>();
  app.use("/mutation", rateLimitMutations("WRITE_RATE_LIMITER", "write", ["POST"]));
  app.post("/mutation", (c) => c.body(null, 204));
  return app;
}
