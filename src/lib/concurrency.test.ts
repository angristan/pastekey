import { describe, expect, it } from "vitest";

import { settledMap } from "./concurrency";

describe("settledMap", () => {
  it("bounds concurrency, preserves order, and isolates failures", async () => {
    let active = 0;
    let maximum = 0;
    const result = await settledMap([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, value % 2 ? 2 : 1));
      active -= 1;
      if (value === 4) throw new Error("corrupt");
      return value * 2;
    });

    expect(maximum).toBe(2);
    expect(result).toEqual({ values: [2, 4, 6, 10, 12], failureCount: 1 });
  });

  it("rejects invalid concurrency", async () => {
    await expect(settledMap([1], 0, async (value) => value)).rejects.toThrow("positive integer");
  });
});
