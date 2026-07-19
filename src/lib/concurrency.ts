import { Effect, Result, Schema } from "effect";

export class InvalidConcurrencyError extends Schema.TaggedErrorClass<InvalidConcurrencyError>()(
  "InvalidConcurrencyError",
  {
    message: Schema.String,
    concurrency: Schema.Number,
  },
) {}

export const settledMapEffect = Effect.fn("settledMap")(function*<T, U, E, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Effect.Effect<U, E, R>,
) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    return yield* InvalidConcurrencyError.make({
      message: "Concurrency must be a positive integer",
      concurrency,
    });
  }

  const results = yield* Effect.forEach(
    values,
    (value, index) => Effect.result(map(value, index)),
    { concurrency },
  );
  const settledValues: U[] = [];
  let failureCount = 0;
  for (const result of results) {
    if (Result.isSuccess(result)) settledValues.push(result.success);
    else failureCount += 1;
  }
  return { values: settledValues, failureCount };
});

/** Promise adapter retained while browser callers migrate to Effect. */
export function settledMap<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<U>,
): Promise<{ values: U[]; failureCount: number }> {
  return Effect.runPromise(settledMapEffect(
    values,
    concurrency,
    (value, index) => Effect.tryPromise(() => map(value, index)),
  ));
}
