import { Effect, Layer, Result } from "effect";

import {
  AccountWorkflow,
  AnalyticsEngine,
  DeletionQueue,
  R2FileStorage,
  RateLimiter,
  accountWorkflowLayer,
  analyticsEngineLayer,
  deletionQueueLayer,
  r2FileStorageLayer,
  rateLimiterLayer,
} from "./platform/cloudflare";
import { D1, layer as d1Layer } from "./platform/d1";
import type { Bindings } from "./types";

export type WorkerServices =
  | D1
  | R2FileStorage
  | DeletionQueue
  | AccountWorkflow
  | AnalyticsEngine
  | RateLimiter;

export function workerLayer(env: Bindings): Layer.Layer<WorkerServices> {
  return Layer.mergeAll(
    d1Layer(env.DB),
    r2FileStorageLayer(env.FILES),
    deletionQueueLayer(env.DELETION_QUEUE),
    accountWorkflowLayer(env.ACCOUNT_DELETION),
    analyticsEngineLayer(env.EVENTS),
    rateLimiterLayer({
      AUTH_RATE_LIMITER: env.AUTH_RATE_LIMITER,
      WRITE_RATE_LIMITER: env.WRITE_RATE_LIMITER,
    }),
  );
}

export function runWorkerEffect<A, E>(
  env: Bindings,
  effect: Effect.Effect<A, E, WorkerServices>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(workerLayer(env)),
      Effect.result,
    ),
  ).then((result) => {
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  });
}
