import type { MiddlewareHandler } from "hono";

import type { AppEnv, Bindings } from "../types";

export type AnalyticsOperation =
  | "auth_register_options"
  | "auth_register_verify"
  | "auth_login_options"
  | "auth_login_verify"
  | "passkey_add_options"
  | "passkey_remove"
  | "item_create"
  | "item_update"
  | "item_delete"
  | "file_upload"
  | "file_remove"
  | "file_download"
  | "share_create"
  | "share_revoke"
  | "share_open"
  | "shared_file_download";

export function recordApiAnalytics(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const operation = analyticsOperation(c.req.method, new URL(c.req.url).pathname);
    if (!operation) {
      await next();
      return;
    }

    const startedAt = performance.now();
    try {
      await next();
      record(c.env, operation, c.res.status, performance.now() - startedAt, metricBytes(operation, c.req.raw, c.res));
    } catch (error) {
      record(c.env, operation, 500, performance.now() - startedAt, metricBytes(operation, c.req.raw));
      throw error;
    }
  };
}

export function analyticsOperation(method: string, pathname: string): AnalyticsOperation | null {
  const segments = pathname.split("/").filter(Boolean);

  if (method === "POST") {
    if (pathname === "/api/auth/register/options") return "auth_register_options";
    if (pathname === "/api/auth/register/verify") return "auth_register_verify";
    if (pathname === "/api/auth/login/options") return "auth_login_options";
    if (pathname === "/api/auth/login/verify") return "auth_login_verify";
    if (pathname === "/api/auth/passkeys/options") return "passkey_add_options";
    if (segments.length === 2 && segments[0] === "api" && segments[1] === "pastes") return "item_create";
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "pastes" && segments[3] === "shares") {
      return "share_create";
    }
  }

  if (method === "PUT") {
    if (segments.length === 3 && segments[0] === "api" && segments[1] === "pastes") return "item_update";
    if (segments.length === 5 && segments[0] === "api" && segments[1] === "pastes" && segments[3] === "files") {
      return "file_upload";
    }
  }

  if (method === "DELETE") {
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "auth" && segments[2] === "passkeys") {
      return "passkey_remove";
    }
    if (segments.length === 3 && segments[0] === "api" && segments[1] === "pastes") return "item_delete";
    if (segments.length === 5 && segments[0] === "api" && segments[1] === "pastes" && segments[3] === "files") {
      return "file_remove";
    }
    if (segments.length === 5 && segments[0] === "api" && segments[1] === "pastes" && segments[3] === "shares") {
      return "share_revoke";
    }
  }

  if (method === "GET") {
    if (segments.length === 6 && segments[0] === "api" && segments[1] === "pastes" && segments[3] === "files" && segments[5] === "content") {
      return "file_download";
    }
    if (segments.length === 3 && segments[0] === "api" && segments[1] === "shares") return "share_open";
    if (segments.length === 6 && segments[0] === "api" && segments[1] === "shares" && segments[3] === "files" && segments[5] === "content") {
      return "shared_file_download";
    }
  }

  return null;
}

function record(
  env: Bindings,
  operation: AnalyticsOperation,
  status: number,
  durationMs: number,
  bytes?: number,
) {
  try {
    // Schema: blob1=operation, blob2=outcome, blob3=size bucket; double1=duration ms, double2=status.
    // No identifiers, paths, IP addresses, filenames, or content are recorded.
    env.EVENTS.writeDataPoint({
      blobs: [operation, outcome(status), sizeBucket(bytes)],
      doubles: [Math.round(durationMs * 100) / 100, status],
      indexes: [operation],
    });
  } catch (error) {
    // Product analytics must never affect request availability.
    console.error("Analytics Engine unavailable", error);
  }
}

function outcome(status: number) {
  if (status < 400) return "success";
  if (status === 429) return "rate_limited";
  if (status < 500) return "client_error";
  return "server_error";
}

function sizeBucket(bytes?: number) {
  if (!bytes || bytes < 1) return "none";
  if (bytes < 1024 * 1024) return "under_1_mib";
  if (bytes < 5 * 1024 * 1024) return "1_to_5_mib";
  if (bytes < 10 * 1024 * 1024) return "5_to_10_mib";
  return "10_to_25_mib";
}

function metricBytes(operation: AnalyticsOperation, request: Request, response?: Response) {
  const value = operation === "file_upload"
    ? request.headers.get("Content-Length")
    : operation === "file_download" || operation === "shared_file_download"
      ? response?.headers.get("Content-Length")
      : null;
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
