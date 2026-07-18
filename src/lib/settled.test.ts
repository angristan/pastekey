import { describe, expect, it } from "vitest";

import { settledValues } from "./settled";

describe("settledValues", () => {
  it("returns valid values and an aggregate failure count", async () => {
    const result = await settledValues([
      Promise.resolve("first"),
      Promise.reject(new Error("corrupt ciphertext")),
      Promise.resolve("second"),
    ]);

    expect(result).toEqual({ values: ["first", "second"], failureCount: 1 });
  });
});
