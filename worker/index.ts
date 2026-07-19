import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import type { AppConfig } from "../shared/protocol/config";
import { OPAQUE_ID, serviceLimits } from "./lib/config";
import { ApiHttpError } from "./lib/errors";
import { RequestBodyTooLargeError } from "./lib/http";
import { recordApiAnalytics } from "./middleware/analytics";
import { rateLimitMutations } from "./middleware/rate-limit";
import { accountRoutes } from "./routes/account";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
import { pasteRoutes } from "./routes/pastes";
import { shareRoutes } from "./routes/shares";
import { runWorkerEffect } from "./runtime";
import { reconcileAccountDeletionsEffect } from "./services/account-deletions";
import { cleanupExpired } from "./services/cleanup";
import { consumeDeletionQueue } from "./services/deletions";
import { registrationEnabled } from "./services/feature-flags";
import { recordLifecycleMetrics } from "./services/lifecycle-metrics";
import type { AppEnv, Bindings, DeletionMessage } from "./types";

export { AccountDeletionWorkflow } from "./workflows/account-deletion";

const app = new Hono<AppEnv>();

app.use("/api/*", secureHeaders());
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.use("/api/*", recordApiAnalytics());
app.use("/api/auth/*", rateLimitMutations("AUTH_RATE_LIMITER", "auth", ["POST"]));
app.use("/api/account", rateLimitMutations("WRITE_RATE_LIMITER", "write", ["DELETE"]));
app.use("/api/pastes/*", rateLimitMutations("WRITE_RATE_LIMITER", "write", ["POST", "PUT", "DELETE"]));

app.on(["GET", "HEAD"], "/s/:id", async (c) => {
  if (!OPAQUE_ID.test(c.req.param("id"))) return c.json({ error: "Not found" }, 404);

  const assetUrl = new URL("/", c.req.url);
  const response = await c.env.ASSETS.fetch(new Request(assetUrl, {
    method: c.req.method,
    headers: c.req.raw.headers,
  }));
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return new Response(response.body, { status: response.status, headers });
});

app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/api/config", async (c) => {
  c.header("Cache-Control", "public, max-age=30");
  const hostname = new URL(c.req.url).hostname;
  const localWithoutSecret = (hostname === "localhost" || hostname === "127.0.0.1") && !c.env.TURNSTILE_SECRET_KEY;
  return c.json<AppConfig>({
    limits: serviceLimits(c.env),
    registrationEnabled: await runWorkerEffect(c.env, registrationEnabled()),
    turnstileSiteKey: localWithoutSecret ? null : (c.env.TURNSTILE_SITE_KEY ?? null),
  });
});

app.route("/", accountRoutes);
app.route("/", authRoutes);
app.route("/", pasteRoutes);
app.route("/", attachmentRoutes);
app.route("/", shareRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  if (error instanceof RequestBodyTooLargeError) {
    return c.json({ error: "Request body too large" }, 413);
  }
  if (error instanceof ApiHttpError) {
    if (error.report) console.error("Handled API infrastructure error", error.cause ?? error);
    return c.json({ error: error.message }, error.status);
  }
  console.error("Unhandled API error", error);
  return c.json({ error: "Unexpected server error" }, 500);
});

export default {
  fetch: app.fetch,
  queue(batch, env) {
    return consumeDeletionQueue(batch, env);
  },
  scheduled(_controller, env, context) {
    context.waitUntil(isolateScheduledFailure(
      runWorkerEffect(env, cleanupExpired(), {
        name: "pastekey.cleanup.expired",
        trigger: "scheduled",
      }),
      "Scheduled ciphertext cleanup failed",
    ));
    context.waitUntil(isolateScheduledFailure(
      runWorkerEffect(env, reconcileAccountDeletionsEffect(), {
        name: "pastekey.account.deletion.reconcile",
        trigger: "scheduled",
      }),
      "Scheduled account deletion reconciliation failed",
    ));
    context.waitUntil(isolateScheduledFailure(
      runWorkerEffect(env, recordLifecycleMetrics(), {
        name: "pastekey.lifecycle.metrics.record",
        trigger: "scheduled",
      }),
      "Scheduled lifecycle metrics failed",
    ));
  },
} satisfies ExportedHandler<Bindings, DeletionMessage>;

async function isolateScheduledFailure(task: Promise<unknown>, message: string) {
  try {
    await task;
  } catch (error) {
    console.error(message, error);
  }
}
