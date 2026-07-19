import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { settledValues, settledValuesEffect } from "./settled";

describe("settledValues", () => {
  it.effect("preserves successful ordering and counts failures and defects", () => Effect.gen(function*() {
    const result = yield* settledValuesEffect([
      Effect.succeed("first"),
      Effect.fail("corrupt ciphertext"),
      Effect.die("invalid attachment"),
      Effect.succeed("second"),
    ]);

    expect(result).toEqual({ values: ["first", "second"], failureCount: 2 });
  }));

  it("retains the Promise adapter", async () => {
    const result = await settledValues([
      Promise.resolve("first"),
      Promise.reject(new Error("corrupt ciphertext")),
      Promise.resolve("second"),
    ]);

    expect(result).toEqual({ values: ["first", "second"], failureCount: 1 });
  });
});
