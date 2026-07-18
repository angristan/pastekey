export type ApiErrorStatus = 409 | 503;

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

export function throwUniqueConflict(cause: unknown, message: string): never {
  if (isD1UniqueConstraint(cause)) {
    throw new ApiHttpError(409, message, { cause });
  }
  throw cause;
}

export function serviceUnavailable(message: string, cause: unknown) {
  return new ApiHttpError(503, message, { cause, report: true });
}

export function isD1UniqueConstraint(cause: unknown) {
  if (!(cause instanceof Error)) return false;
  return /(?:UNIQUE constraint failed|SQLITE_CONSTRAINT_(?:PRIMARYKEY|UNIQUE)|constraint failed:.*(?:PRIMARY KEY|UNIQUE))/i
    .test(cause.message);
}
