import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import type { AppConfig } from "../src/lib/types";
import { serviceLimits } from "./lib/config";
import { recordApiAnalytics } from "./middleware/analytics";
import { rateLimitMutations } from "./middleware/rate-limit";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
import { pasteRoutes } from "./routes/pastes";
import { shareRoutes } from "./routes/shares";
import { cleanupExpired } from "./services/cleanup";
import type { AppEnv, Bindings } from "./types";

const app = new Hono<AppEnv>();

app.use("/api/*", secureHeaders());
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.use("/api/*", recordApiAnalytics());
app.use("/api/auth/*", rateLimitMutations("AUTH_RATE_LIMITER", "auth", ["POST"]));
app.use("/api/pastes/*", rateLimitMutations("WRITE_RATE_LIMITER", "write", ["POST", "PUT", "DELETE"]));

app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/api/config", (c) => {
  const hostname = new URL(c.req.url).hostname;
  const localWithoutSecret = (hostname === "localhost" || hostname === "127.0.0.1") && !c.env.TURNSTILE_SECRET_KEY;
  return c.json<AppConfig>({
    limits: serviceLimits(c.env),
    turnstileSiteKey: localWithoutSecret ? null : (c.env.TURNSTILE_SITE_KEY ?? null),
  });
});

app.route("/", authRoutes);
app.route("/", pasteRoutes);
app.route("/", attachmentRoutes);
app.route("/", shareRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  console.error("Unhandled API error", error);
  return c.json({ error: "Unexpected server error" }, 500);
});

export default {
  fetch: app.fetch,
  scheduled(_controller, env, context) {
    context.waitUntil(cleanupExpired(env));
  },
} satisfies ExportedHandler<Bindings>;
