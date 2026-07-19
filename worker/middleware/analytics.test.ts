import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppEnv, Bindings } from "../types";
import { analyticsOperation, recordApiAnalytics } from "./analytics";

function isBindings(value: unknown): value is Bindings {
  return typeof value === "object" && value !== null;
}

if (!isBindings(env)) throw new Error("Cloudflare test bindings are unavailable");
const bindings = env;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Analytics Engine operation classification", () => {
  it.each([
    ["POST", "/api/auth/register/options", "auth_register_options"],
    ["POST", "/api/auth/register/verify", "auth_register_verify"],
    ["POST", "/api/auth/login/options", "auth_login_options"],
    ["POST", "/api/auth/login/verify", "auth_login_verify"],
    ["POST", "/api/auth/passkeys/options", "passkey_add_options"],
    ["DELETE", "/api/auth/passkeys/secret-credential-id", "passkey_remove"],
    ["DELETE", "/api/account", "account_delete"],
    ["POST", "/api/pastes", "item_create"],
    ["PUT", "/api/pastes/secret-item-id", "item_update"],
    ["DELETE", "/api/pastes/secret-item-id", "item_delete"],
    ["PUT", "/api/pastes/secret-item-id/files/secret-file-id", "file_upload"],
    ["DELETE", "/api/pastes/secret-item-id/files/secret-file-id", "file_remove"],
    ["GET", "/api/pastes/secret-item-id/files/secret-file-id/content", "file_download"],
    ["POST", "/api/pastes/secret-item-id/shares", "share_create"],
    ["DELETE", "/api/pastes/secret-item-id/shares/secret-share-id", "share_revoke"],
    ["GET", "/api/shares/secret-share-id", "share_open"],
    ["GET", "/api/shares/secret-share-id/files/secret-file-id/content", "shared_file_download"],
  ])("classifies %s %s without retaining identifiers", (method, pathname, operation) => {
    expect(analyticsOperation(method, pathname)).toBe(operation);
    expect(operation).not.toContain("secret");
  });

  it.each([
    ["GET", "/api/health"],
    ["GET", "/api/config"],
    ["GET", "/api/auth/me"],
    ["GET", "/api/pastes"],
    ["GET", "/unknown"],
  ])("does not record routine request %s %s", (method, pathname) => {
    expect(analyticsOperation(method, pathname)).toBeNull();
  });
});

describe("Analytics Engine middleware", () => {
  it("records only identifier-free bounded fields", async () => {
    const writeDataPoint = vi.fn();
    const app = analyticsApp();
    const response = await app.fetch(
      new Request(
        "https://paste.test/api/shares/secret-share/files/secret-file/content",
        { headers: { "CF-Connecting-IP": "203.0.113.7" } },
      ),
      { ...bindings, EVENTS: { writeDataPoint } },
    );

    expect(response.status).toBe(200);
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ["shared_file_download", "success", "under_1_mib"],
      doubles: [expect.any(Number), 200],
      indexes: ["shared_file_download"],
    });
    const recorded = JSON.stringify(writeDataPoint.mock.calls);
    expect(recorded).not.toContain("secret-share");
    expect(recorded).not.toContain("secret-file");
    expect(recorded).not.toContain("203.0.113.7");
    expect(recorded).not.toContain("/api/");
  });

  it("does not affect the response when Analytics Engine fails", async () => {
    const cause = new Error("dataset unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = analyticsApp();
    const response = await app.fetch(
      new Request("https://paste.test/api/shares/share/files/file/content"),
      {
        ...bindings,
        EVENTS: {
          writeDataPoint: () => {
            throw cause;
          },
        },
      },
    );

    expect(response.status).toBe(200);
    expect(consoleError).toHaveBeenCalledWith(
      "Analytics Engine unavailable",
      expect.objectContaining({ _tag: "AnalyticsEngineError", cause }),
    );
  });
});

function analyticsApp() {
  const app = new Hono<AppEnv>();
  app.use("/api/*", recordApiAnalytics());
  app.get("/api/shares/:shareId/files/:fileId/content", (c) => {
    c.header("Content-Length", "2048");
    return c.body("encrypted attachment");
  });
  return app;
}
