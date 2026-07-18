import { describe, expect, it } from "vitest";

import { mergeShares } from "./share-state";

describe("share state", () => {
  it("merges newly generated and existing summaries without dropping or duplicating links", () => {
    const created = { id: "new", createdAt: 3, expiresAt: null };
    const existing = [
      { id: "old-a", createdAt: 1, expiresAt: null },
      { id: "old-b", createdAt: 2, expiresAt: 10 },
      created,
    ];

    expect(mergeShares([created], existing)).toEqual([
      created,
      existing[0],
      existing[1],
    ]);
  });
});
