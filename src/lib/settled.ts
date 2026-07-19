import { Effect, Exit } from "effect";

import { runClientPromise } from "../effect/runtime";

export const settledValuesEffect = Effect.fn("settledValues")(function*<T, E, R>(
  effects: Iterable<Effect.Effect<T, E, R>>,
) {
  const exits = yield* Effect.forEach(
    effects,
    (effect) => Effect.exit(effect),
    { concurrency: "unbounded" },
  );
  const values: T[] = [];
  let failureCount = 0;
  for (const exit of exits) {
    if (Exit.isSuccess(exit)) values.push(exit.value);
    else failureCount += 1;
  }
  return { values, failureCount };
});

/** Promise adapter retained while browser callers migrate to Effect. */
export function settledValues<T>(
  promises: Iterable<PromiseLike<T>>,
): Promise<{ values: T[]; failureCount: number }> {
  const effects = globalThis.Array.from(
    promises,
    (promise) => Effect.tryPromise(() => promise),
  );
  return runClientPromise(settledValuesEffect(effects));
}
