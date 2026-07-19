import { Effect, Layer, Result } from "effect";

import {
  AccountWorkflow,
  AnalyticsEngine,
  DeletionQueue,
  FeatureFlags,
  R2FileStorage,
  RateLimiter,
  accountWorkflowLayer,
  analyticsEngineLayer,
  deletionQueueLayer,
  featureFlagsLayer,
  r2FileStorageLayer,
  rateLimiterLayer,
} from "./platform/cloudflare";
import { D1, layer as d1Layer } from "./platform/d1";
import {
  traceWorkerOperation,
  type WorkerSpanOptions,
} from "./lib/tracing";
import type { Bindings } from "./types";

export type WorkerServices =
  | D1
  | R2FileStorage
  | DeletionQueue
  | AccountWorkflow
  | AnalyticsEngine
  | RateLimiter
  | FeatureFlags;

export function workerLayer(env: Bindings): Layer.Layer<WorkerServices> {
  return Layer.mergeAll(
    d1Layer(env.DB),
    r2FileStorageLayer(env.FILES),
    deletionQueueLayer(env.DELETION_QUEUE),
    accountWorkflowLayer(env.ACCOUNT_DELETION),
    analyticsEngineLayer(env.EVENTS),
    featureFlagsLayer(env.FLAGS),
    rateLimiterLayer({
      AUTH_RATE_LIMITER: env.AUTH_RATE_LIMITER,
      WRITE_RATE_LIMITER: env.WRITE_RATE_LIMITER,
    }),
  );
}

export function runWorkerEffect<A, E>(
  env: Bindings,
  effect: Effect.Effect<A, E, WorkerServices>,
  span?: WorkerSpanOptions,
): Promise<A> {
  const run = () => Effect.runPromise(
    effect.pipe(
      Effect.provide(workerLayer(env)),
      Effect.result,
    ),
  ).then((result) => {
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  });
  return span === undefined ? run() : traceWorkerOperation(span, run);
}
