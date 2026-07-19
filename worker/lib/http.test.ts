import { Effect } from "effect";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { readJson, RequestBodyTooLargeError } from "./http";
import { runWorkerEffect } from "../runtime";
import type { AppEnv, Bindings } from "../types";

const app = new Hono<AppEnv>();
app.post("/", async (c) => c.json({
  value: await runWorkerEffect(
    c.env,
    readJson(c, 16).pipe(
      Effect.catchTags({
        RequestBodyReadError: () => Effect.succeed(null),
        RequestBodyParseError: () => Effect.succeed(null),
      }),
    ),
  ),
}));
app.onError((error, c) => error instanceof RequestBodyTooLargeError
  ? c.json({ error: "Request body too large" }, 413)
  : c.json({ error: "Unexpected" }, 500));

const context = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

describe("bounded JSON parsing", () => {
  it("rejects a declared oversized body before parsing", async () => {
    const response = await app.fetch(new Request("https://paste.test/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "17" },
      body: "{}",
    }), {} as Bindings, context);

    expect(response.status).toBe(413);
  });

  it("stream-caps a body without Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new TextEncoder().encode('too-large"}'));
        controller.close();
      },
    });
    const response = await app.fetch(new Request("https://paste.test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }), {} as Bindings, context);

    expect(response.status).toBe(413);
  });

  it("parses an in-limit body and preserves malformed handling", async () => {
    const valid = await app.fetch(new Request("https://paste.test/", {
      method: "POST",
      body: '{"ok":true}',
    }), {} as Bindings, context);
    await expect(valid.json()).resolves.toEqual({ value: { ok: true } });

    const malformed = await app.fetch(new Request("https://paste.test/", {
      method: "POST",
      body: "{bad",
    }), {} as Bindings, context);
    await expect(malformed.json()).resolves.toEqual({ value: null });
  });
});
