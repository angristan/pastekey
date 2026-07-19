import { Schema } from "effect";

export type ApiErrorStatus = 409 | 503;

export class DomainConflictError extends Schema.TaggedErrorClass<DomainConflictError>()(
  "DomainConflictError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class DomainUnavailableError extends Schema.TaggedErrorClass<DomainUnavailableError>()(
  "DomainUnavailableError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ApiHttpError extends Error {
  constructor(
    readonly status: ApiErrorStatus,
    message: string,
    options?: { cause?: unknown; report?: boolean },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ApiHttpError";
    this.report = options?.report ?? false;
  }

  readonly report: boolean;
}

export function isD1UniqueConstraint(cause: unknown) {
  if (!(cause instanceof Error)) return false;
  return /(?:UNIQUE constraint failed|SQLITE_CONSTRAINT_(?:PRIMARYKEY|UNIQUE)|constraint failed:.*(?:PRIMARY KEY|UNIQUE))/i
    .test(cause.message);
}
