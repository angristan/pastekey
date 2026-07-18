import { describe, expect, it } from "vitest";

import { ApiHttpError, isD1UniqueConstraint, serviceUnavailable, throwUniqueConflict } from "./errors";

describe("API infrastructure errors", () => {
  it("recognizes only D1 uniqueness conflicts", () => {
    expect(isD1UniqueConstraint(new Error("D1_ERROR: UNIQUE constraint failed: pastes.id: SQLITE_CONSTRAINT"))).toBe(true);
    expect(isD1UniqueConstraint(new Error("D1_ERROR: no such table: pastes"))).toBe(false);
    expect(isD1UniqueConstraint(new Error("network unavailable"))).toBe(false);
  });

  it("maps unique conflicts and preserves unexpected failures", () => {
    expect(() => throwUniqueConflict(
      new Error("D1_ERROR: UNIQUE constraint failed: shares.id: SQLITE_CONSTRAINT"),
      "Share ID already exists",
    )).toThrowError(expect.objectContaining({ status: 409, message: "Share ID already exists" }));

    const outage = new Error("D1 unavailable");
    expect(() => throwUniqueConflict(outage, "Conflict")).toThrow(outage);
  });

  it("marks service failures for central reporting", () => {
    const cause = new Error("R2 unavailable");
    const error = serviceUnavailable("Upload failed", cause);
    expect(error).toBeInstanceOf(ApiHttpError);
    expect(error).toMatchObject({ status: 503, message: "Upload failed", report: true, cause });
  });
});
