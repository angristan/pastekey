import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";

import {
  ApiDecodeError,
  ApiStatusError,
  ApiTransportError,
  makeApiClient,
  type FetchImplementation,
} from "./api";

const Result = Schema.Struct({ value: Schema.String });

describe("ApiClient", () => {
  it.effect("returns typed status errors with the server message", () =>
    Effect.gen(function* () {
      const client = makeApiClient(() => Promise.resolve(Response.json(
        { error: "Access denied" },
        { status: 403 },
      )));

      const error = yield* Effect.flip(client.request("/api/private", Result));

      assert.instanceOf(error, ApiStatusError);
      assert.strictEqual(error.status, 403);
      assert.strictEqual(error.message, "Access denied");
    }),
  );

  it.effect("uses the status fallback for malformed error bodies", () =>
    Effect.gen(function* () {
      const client = makeApiClient(() => Promise.resolve(new Response("not-json", {
        status: 502,
      })));

      const error = yield* Effect.flip(client.request("/api/upstream", Result));

      assert.instanceOf(error, ApiStatusError);
      assert.strictEqual(error.status, 502);
      assert.strictEqual(error.message, "Request failed (502)");
    }),
  );

  it.effect("maps malformed JSON and schema mismatches to decode errors", () =>
    Effect.gen(function* () {
      const malformed = makeApiClient(() => Promise.resolve(new Response("{")));
      const invalid = makeApiClient(() => Promise.resolve(Response.json({ value: 1 })));

      const malformedError = yield* Effect.flip(malformed.request("/api/value", Result));
      const schemaError = yield* Effect.flip(invalid.request("/api/value", Result));

      assert.instanceOf(malformedError, ApiDecodeError);
      assert.strictEqual(malformedError.message, "Failed to parse the API response as JSON");
      assert.instanceOf(schemaError, ApiDecodeError);
      assert.strictEqual(schemaError.message, "API response did not match the expected schema");
    }),
  );

  it.effect("maps fetch rejection to a typed transport error without retrying", () =>
    Effect.gen(function* () {
      const cause = new Error("offline");
      let calls = 0;
      const client = makeApiClient(() => {
        calls += 1;
        return Promise.reject(cause);
      });

      const error = yield* Effect.flip(client.request("/api/value", Result));

      assert.instanceOf(error, ApiTransportError);
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(error.message, "offline");
      assert.strictEqual(calls, 1);
    }),
  );

  it.effect("aborts the fetch signal when the request effect is interrupted", () =>
    Effect.gen(function* () {
      let observedSignal: AbortSignal | undefined;
      const fetchImplementation: FetchImplementation = (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          observedSignal = signal ?? undefined;
          if (signal === undefined || signal === null) {
            reject(new Error("missing AbortSignal"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      const client = makeApiClient(fetchImplementation);

      const fiber = yield* Effect.forkChild(client.request("/api/slow", Result));
      yield* Effect.yieldNow;
      assert.isDefined(observedSignal);

      yield* Fiber.interrupt(fiber);

      assert.isTrue(observedSignal?.aborted);
    }),
  );

  it.effect("adds the JSON header for string bodies and preserves overrides", () =>
    Effect.gen(function* () {
      const captured: Array<RequestInit | undefined> = [];
      const client = makeApiClient((_input, init) => {
        captured.push(init);
        return Promise.resolve(Response.json({ value: "ok" }));
      });

      yield* client.request("/api/value", Result, { body: "{}", method: "POST" });
      yield* client.request("/api/value", Result, {
        body: "{}",
        headers: { "Content-Type": "application/custom", "X-Test": "yes" },
        method: "POST",
      });

      const automatic = new Headers(captured[0]?.headers);
      const overridden = new Headers(captured[1]?.headers);
      assert.strictEqual(automatic.get("Content-Type"), "application/json");
      assert.strictEqual(overridden.get("Content-Type"), "application/custom");
      assert.strictEqual(overridden.get("X-Test"), "yes");
    }),
  );

  it.effect("decodes 204 responses as void without reading JSON", () =>
    Effect.gen(function* () {
      const client = makeApiClient(() => Promise.resolve(new Response(null, { status: 204 })));

      const result = yield* client.request("/api/value", Schema.Undefined, { method: "DELETE" });

      assert.isUndefined(result);
    }),
  );
});
