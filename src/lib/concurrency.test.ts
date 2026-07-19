import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { InvalidConcurrencyError, settledMap, settledMapEffect } from "./concurrency";

describe("settledMap", () => {
  it.effect("bounds concurrency, preserves order, and isolates failures", () => Effect.gen(function*() {
    let active = 0;
    let maximum = 0;
    const fiber = yield* Effect.forkChild(settledMapEffect(
      [1, 2, 3, 4, 5, 6],
      2,
      (value) => Effect.gen(function*() {
        active += 1;
        maximum = Math.max(maximum, active);
        yield* Effect.sleep(value % 2 ? "2 millis" : "1 millis");
        active -= 1;
        if (value === 4) return yield* Effect.fail("corrupt");
        return value * 2;
      }),
    ));

    yield* Effect.yieldNow;
    yield* TestClock.adjust("10 millis");
    const result = yield* Fiber.join(fiber);

    expect(maximum).toBe(2);
    expect(result).toEqual({ values: [2, 4, 6, 10, 12], failureCount: 1 });
  }));

  it("rejects invalid concurrency through the Promise adapter", async () => {
    await expect(settledMap([1], 0, async (value) => value)).rejects.toEqual(
      InvalidConcurrencyError.make({
        message: "Concurrency must be a positive integer",
        concurrency: 0,
      }),
    );
  });
});
