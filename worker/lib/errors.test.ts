import { describe, expect, it } from "vitest";

import { R2FileStorageError } from "../platform/cloudflare";
import { D1Error } from "../platform/d1";
import {
  ApiHttpError,
  DomainConflictError,
  DomainUnavailableError,
  isD1UniqueConstraint,
} from "./errors";

describe("domain and API errors", () => {
  it("recognizes only D1 uniqueness conflicts", () => {
    expect(isD1UniqueConstraint(new Error("D1_ERROR: UNIQUE constraint failed: pastes.id: SQLITE_CONSTRAINT"))).toBe(true);
    expect(isD1UniqueConstraint(new Error("D1_ERROR: no such table: pastes"))).toBe(false);
    expect(isD1UniqueConstraint(new Error("network unavailable"))).toBe(false);
  });

  it("preserves typed infrastructure failures as domain causes", () => {
    const d1Cause = D1Error.make({
      operation: "run",
      cause: new Error("UNIQUE constraint failed: pastes.id"),
    });
    const conflict = DomainConflictError.make({
      message: "Item ID already exists",
      cause: d1Cause,
    });
    expect(conflict).toMatchObject({
      _tag: "DomainConflictError",
      message: "Item ID already exists",
      cause: d1Cause,
    });

    const r2Cause = R2FileStorageError.make({
      operation: "put",
      cause: new Error("R2 unavailable"),
    });
    const unavailable = DomainUnavailableError.make({
      message: "Encrypted attachment upload failed",
      cause: r2Cause,
    });
    expect(unavailable).toMatchObject({
      _tag: "DomainUnavailableError",
      message: "Encrypted attachment upload failed",
      cause: r2Cause,
    });
  });

  it("keeps HTTP reporting metadata in the transport error", () => {
    const cause = new Error("R2 unavailable");
    const error = new ApiHttpError(503, "Upload failed", { cause, report: true });
    expect(error).toMatchObject({ status: 503, message: "Upload failed", report: true, cause });
  });
});
