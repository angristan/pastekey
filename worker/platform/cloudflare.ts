import { Context, Effect, Layer, Schema } from "effect";
import type { AccountDeletionPayload, DeletionMessage, FlagshipBinding } from "../types";

export class FeatureFlagError extends Schema.TaggedErrorClass<FeatureFlagError>()(
  "FeatureFlagError",
  {
    flagKey: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class FeatureFlags extends Context.Service<
  FeatureFlags,
  {
    readonly getBooleanValue: (
      flagKey: string,
      defaultValue: boolean,
      context?: FlagshipEvaluationContext,
    ) => Effect.Effect<boolean, FeatureFlagError>;
  }
>()("pastekey/platform/FeatureFlags") {}

export const makeFeatureFlags = (
  binding: FlagshipBinding,
): Context.Service.Shape<typeof FeatureFlags> => ({
  getBooleanValue: (flagKey, defaultValue, context) =>
    Effect.tryPromise({
      try: () => binding.getBooleanValue(flagKey, defaultValue, context),
      catch: (cause) => FeatureFlagError.make({ flagKey, cause }),
    }),
});

export const featureFlagsLayer = (
  binding: FlagshipBinding,
): Layer.Layer<FeatureFlags> => Layer.succeed(FeatureFlags, makeFeatureFlags(binding));

export type R2FileValue = Parameters<R2Bucket["put"]>[1];

export interface R2FileStorageBinding {
  readonly put: (key: string, value: R2FileValue, options?: R2PutOptions) => Promise<R2Object>;
  readonly get: (key: string, options?: R2GetOptions) => Promise<R2ObjectBody | null>;
  readonly delete: (keys: string | string[]) => Promise<void>;
}

export const R2FileStorageOperation = Schema.Literals(["put", "get", "delete"]);
export type R2FileStorageOperation = typeof R2FileStorageOperation.Type;

export class R2FileStorageError extends Schema.TaggedErrorClass<R2FileStorageError>()(
  "R2FileStorageError",
  {
    operation: R2FileStorageOperation,
    cause: Schema.Defect(),
  },
) {}

export class R2FileStorage extends Context.Service<
  R2FileStorage,
  {
    readonly put: (
      key: string,
      value: R2FileValue,
      options?: R2PutOptions,
    ) => Effect.Effect<R2Object, R2FileStorageError>;
    readonly get: (
      key: string,
      options?: R2GetOptions,
    ) => Effect.Effect<R2ObjectBody | null, R2FileStorageError>;
    readonly delete: (keys: string | string[]) => Effect.Effect<void, R2FileStorageError>;
  }
>()("pastekey/platform/R2FileStorage") {}

const failR2 = (operation: R2FileStorageOperation) => (cause: unknown) =>
  R2FileStorageError.make({ operation, cause });

export const makeR2FileStorage = (
  bucket: R2FileStorageBinding,
): Context.Service.Shape<typeof R2FileStorage> => ({
  put: (key, value, options) =>
    Effect.tryPromise({
      try: () => bucket.put(key, value, options),
      catch: failR2("put"),
    }),
  get: (key, options) =>
    Effect.tryPromise({
      try: () => bucket.get(key, options),
      catch: failR2("get"),
    }),
  delete: (keys) =>
    Effect.tryPromise({
      try: () => bucket.delete(keys),
      catch: failR2("delete"),
    }),
});

export const r2FileStorageLayer = (
  bucket: R2FileStorageBinding,
): Layer.Layer<R2FileStorage> => Layer.succeed(R2FileStorage, makeR2FileStorage(bucket));

export interface DeletionQueueBinding {
  readonly sendBatch: (
    messages: Iterable<MessageSendRequest<DeletionMessage>>,
    options?: QueueSendBatchOptions,
  ) => Promise<QueueSendBatchResponse>;
}

export const DeletionQueueOperation = Schema.Literal("sendBatch");
export type DeletionQueueOperation = typeof DeletionQueueOperation.Type;

export class DeletionQueueError extends Schema.TaggedErrorClass<DeletionQueueError>()(
  "DeletionQueueError",
  {
    operation: DeletionQueueOperation,
    cause: Schema.Defect(),
  },
) {}

export class DeletionQueue extends Context.Service<
  DeletionQueue,
  {
    readonly sendBatch: (
      messages: Iterable<MessageSendRequest<DeletionMessage>>,
      options?: QueueSendBatchOptions,
    ) => Effect.Effect<QueueSendBatchResponse, DeletionQueueError>;
  }
>()("pastekey/platform/DeletionQueue") {}

const failDeletionQueue = (cause: unknown) =>
  DeletionQueueError.make({ operation: "sendBatch", cause });

export const makeDeletionQueue = (
  queue: DeletionQueueBinding,
): Context.Service.Shape<typeof DeletionQueue> => ({
  sendBatch: (messages, options) =>
    Effect.tryPromise({
      try: () => queue.sendBatch(messages, options),
      catch: failDeletionQueue,
    }),
});

export const deletionQueueLayer = (
  queue: DeletionQueueBinding,
): Layer.Layer<DeletionQueue> => Layer.succeed(DeletionQueue, makeDeletionQueue(queue));

export interface AccountWorkflowBinding {
  readonly create: (
    options?: WorkflowInstanceCreateOptions<AccountDeletionPayload>,
  ) => Promise<WorkflowInstance>;
  readonly get: (id: string) => Promise<WorkflowInstance>;
}

export const AccountWorkflowOperation = Schema.Literals(["create", "get"]);
export type AccountWorkflowOperation = typeof AccountWorkflowOperation.Type;

export class AccountWorkflowError extends Schema.TaggedErrorClass<AccountWorkflowError>()(
  "AccountWorkflowError",
  {
    operation: AccountWorkflowOperation,
    cause: Schema.Defect(),
  },
) {}

export class AccountWorkflow extends Context.Service<
  AccountWorkflow,
  {
    readonly create: (
      options?: WorkflowInstanceCreateOptions<AccountDeletionPayload>,
    ) => Effect.Effect<WorkflowInstance, AccountWorkflowError>;
    readonly get: (id: string) => Effect.Effect<WorkflowInstance, AccountWorkflowError>;
  }
>()("pastekey/platform/AccountWorkflow") {}

const failAccountWorkflow = (operation: AccountWorkflowOperation) => (cause: unknown) =>
  AccountWorkflowError.make({ operation, cause });

export const makeAccountWorkflow = (
  workflow: AccountWorkflowBinding,
): Context.Service.Shape<typeof AccountWorkflow> => ({
  create: (options) =>
    Effect.tryPromise({
      try: () => workflow.create(options),
      catch: failAccountWorkflow("create"),
    }),
  get: (id) =>
    Effect.tryPromise({
      try: () => workflow.get(id),
      catch: failAccountWorkflow("get"),
    }),
});

export const accountWorkflowLayer = (
  workflow: AccountWorkflowBinding,
): Layer.Layer<AccountWorkflow> => Layer.succeed(AccountWorkflow, makeAccountWorkflow(workflow));

export interface AnalyticsEngineBinding {
  readonly writeDataPoint: (event?: AnalyticsEngineDataPoint) => void;
}

export const AnalyticsEngineOperation = Schema.Literal("write");
export type AnalyticsEngineOperation = typeof AnalyticsEngineOperation.Type;

export class AnalyticsEngineError extends Schema.TaggedErrorClass<AnalyticsEngineError>()(
  "AnalyticsEngineError",
  {
    operation: AnalyticsEngineOperation,
    cause: Schema.Defect(),
  },
) {}

export class AnalyticsEngine extends Context.Service<
  AnalyticsEngine,
  {
    readonly write: (event?: AnalyticsEngineDataPoint) => Effect.Effect<void, AnalyticsEngineError>;
  }
>()("pastekey/platform/AnalyticsEngine") {}

const failAnalyticsEngine = (cause: unknown) =>
  AnalyticsEngineError.make({ operation: "write", cause });

export const makeAnalyticsEngine = (
  dataset: AnalyticsEngineBinding,
): Context.Service.Shape<typeof AnalyticsEngine> => ({
  write: (event) =>
    Effect.try({
      try: () => dataset.writeDataPoint(event),
      catch: failAnalyticsEngine,
    }),
});

export const analyticsEngineLayer = (
  dataset: AnalyticsEngineBinding,
): Layer.Layer<AnalyticsEngine> => Layer.succeed(AnalyticsEngine, makeAnalyticsEngine(dataset));

export interface RateLimiterBinding {
  readonly limit: (options: RateLimitOptions) => Promise<RateLimitOutcome>;
}

export const RateLimiterBindingName = Schema.Literals([
  "AUTH_RATE_LIMITER",
  "WRITE_RATE_LIMITER",
]);
export type RateLimiterBindingName = typeof RateLimiterBindingName.Type;

export interface RateLimiterBindings {
  readonly AUTH_RATE_LIMITER: RateLimiterBinding;
  readonly WRITE_RATE_LIMITER: RateLimiterBinding;
}

export const RateLimiterOperation = Schema.Literal("limit");
export type RateLimiterOperation = typeof RateLimiterOperation.Type;

export class RateLimiterError extends Schema.TaggedErrorClass<RateLimiterError>()(
  "RateLimiterError",
  {
    operation: RateLimiterOperation,
    cause: Schema.Defect(),
  },
) {}

export class RateLimiter extends Context.Service<
  RateLimiter,
  {
    readonly limit: (
      binding: RateLimiterBindingName,
      options: RateLimitOptions,
    ) => Effect.Effect<RateLimitOutcome, RateLimiterError>;
  }
>()("pastekey/platform/RateLimiter") {}

const failRateLimiter = (cause: unknown) => RateLimiterError.make({ operation: "limit", cause });

export const makeRateLimiter = (
  limiters: RateLimiterBindings,
): Context.Service.Shape<typeof RateLimiter> => ({
  limit: (binding, options) =>
    Effect.tryPromise({
      try: () => limiters[binding].limit(options),
      catch: failRateLimiter,
    }),
});

export const rateLimiterLayer = (
  limiters: RateLimiterBindings,
): Layer.Layer<RateLimiter> => Layer.succeed(RateLimiter, makeRateLimiter(limiters));
