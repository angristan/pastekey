import type { Effect } from "effect";

/** Lazy host adapter keeps Effect and its schemas out of the initial bundle. */
export function appConfig(signal?: AbortSignal) {
  const options: Effect.RunOptions | undefined = signal === undefined
    ? undefined
    : { signal };
  return import("../effect/config").then(({ runAppConfig }) =>
    runAppConfig(options),
  );
}
