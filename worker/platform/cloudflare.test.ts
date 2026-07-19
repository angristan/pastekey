import { assert, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  AccountWorkflow,
  AccountWorkflowError,
  AnalyticsEngine,
  AnalyticsEngineError,
  DeletionQueue,
  DeletionQueueError,
  R2FileStorage,
  R2FileStorageError,
  RateLimiter,
  RateLimiterError,
  accountWorkflowLayer,
  analyticsEngineLayer,
  deletionQueueLayer,
  makeAccountWorkflow,
  makeAnalyticsEngine,
  makeDeletionQueue,
  makeR2FileStorage,
  makeRateLimiter,
  r2FileStorageLayer,
  rateLimiterLayer,
  type AccountWorkflowBinding,
  type AnalyticsEngineBinding,
  type DeletionQueueBinding,
  type R2FileStorageBinding,
  type R2FileValue,
  type RateLimiterBinding,
} from "./cloudflare";
import type { DeletionMessage } from "../types";

class FakeR2ObjectBody implements R2ObjectBody {
  readonly key = "stored-key";
  readonly version = "version-1";
  readonly size = 3;
  readonly etag = "etag";
  readonly httpEtag = '"etag"';
  readonly checksums: R2Checksums = { toJSON: () => ({}) };
  readonly uploaded = new Date(0);
  readonly storageClass = "Standard";
  readonly body = new ReadableStream<Uint8Array>();
  readonly bodyUsed = false;

  writeHttpMetadata(_headers: Headers): void {}

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0));
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array());
  }

  text(): Promise<string> {
    return Promise.resolve("");
  }

  json<T>(): Promise<T> {
    return Promise.reject(new Error("not implemented by the fake"));
  }

  blob(): Promise<Blob> {
    return Promise.resolve(new Blob());
  }
}

class FakeWorkflowInstance implements WorkflowInstance {
  constructor(readonly id: string) {}

  pause(): Promise<void> {
    return Promise.resolve();
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  terminate(_options?: WorkflowInstanceTerminateOptions): Promise<void> {
    return Promise.resolve();
  }

  restart(_options?: WorkflowInstanceRestartOptions): Promise<void> {
    return Promise.resolve();
  }

  status(): Promise<InstanceStatus> {
    return Promise.resolve({ status: "running" });
  }

  sendEvent(_event: { type: string; payload: unknown }): Promise<void> {
    return Promise.resolve();
  }
}

class FakeR2Binding implements R2FileStorageBinding {
  readonly object = new FakeR2ObjectBody();
  readonly puts: Array<{ key: string; value: R2FileValue; options: R2PutOptions | undefined }> = [];
  readonly gets: Array<{ key: string; options: R2GetOptions | undefined }> = [];
  readonly deletes: Array<string | string[]> = [];

  put(key: string, value: R2FileValue, options?: R2PutOptions): Promise<R2Object> {
    this.puts.push({ key, value, options });
    return Promise.resolve(this.object);
  }

  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    this.gets.push({ key, options });
    return Promise.resolve(this.object);
  }

  delete(keys: string | string[]): Promise<void> {
    this.deletes.push(keys);
    return Promise.resolve();
  }
}

const queueResponse: QueueSendBatchResponse = {
  metadata: { metrics: { backlogCount: 2, backlogBytes: 128 } },
};

class FakeDeletionQueueBinding implements DeletionQueueBinding {
  readonly calls: Array<{
    messages: Iterable<MessageSendRequest<DeletionMessage>>;
    options: QueueSendBatchOptions | undefined;
  }> = [];

  sendBatch(
    messages: Iterable<MessageSendRequest<DeletionMessage>>,
    options?: QueueSendBatchOptions,
  ): Promise<QueueSendBatchResponse> {
    this.calls.push({ messages, options });
    return Promise.resolve(queueResponse);
  }
}

class FakeAccountWorkflowBinding implements AccountWorkflowBinding {
  readonly instance = new FakeWorkflowInstance("workflow-1");
  readonly creates: Array<WorkflowInstanceCreateOptions<{ userId: string }> | undefined> = [];
  readonly gets: Array<string> = [];

  create(
    options?: WorkflowInstanceCreateOptions<{ userId: string }>,
  ): Promise<WorkflowInstance> {
    this.creates.push(options);
    return Promise.resolve(this.instance);
  }

  get(id: string): Promise<WorkflowInstance> {
    this.gets.push(id);
    return Promise.resolve(this.instance);
  }
}

class FakeAnalyticsEngineBinding implements AnalyticsEngineBinding {
  readonly events: Array<AnalyticsEngineDataPoint | undefined> = [];

  writeDataPoint(event?: AnalyticsEngineDataPoint): void {
    this.events.push(event);
  }
}

const rateLimitOutcome: RateLimitOutcome = { success: true };

class FakeRateLimiterBinding implements RateLimiterBinding {
  readonly calls: Array<RateLimitOptions> = [];

  limit(options: RateLimitOptions): Promise<RateLimitOutcome> {
    this.calls.push(options);
    return Promise.resolve(rateLimitOutcome);
  }
}

const r2 = new FakeR2Binding();
const deletionQueue = new FakeDeletionQueueBinding();
const accountWorkflow = new FakeAccountWorkflowBinding();
const analyticsEngine = new FakeAnalyticsEngineBinding();
const rateLimiter = new FakeRateLimiterBinding();

const PlatformTest = Layer.mergeAll(
  r2FileStorageLayer(r2),
  deletionQueueLayer(deletionQueue),
  accountWorkflowLayer(accountWorkflow),
  analyticsEngineLayer(analyticsEngine),
  rateLimiterLayer(rateLimiter),
);

layer(PlatformTest)("Cloudflare platform adapters", (it) => {
  it.effect("delegates exact arguments and preserves native values and streams", () =>
    Effect.gen(function* () {
      const files = yield* R2FileStorage;
      const queue = yield* DeletionQueue;
      const workflow = yield* AccountWorkflow;
      const analytics = yield* AnalyticsEngine;
      const limiter = yield* RateLimiter;

      const stream = new ReadableStream<Uint8Array>();
      const putOptions: R2PutOptions = {
        httpMetadata: { contentType: "application/octet-stream" },
      };
      const getOptions: R2GetOptions = { range: { offset: 4, length: 8 } };
      const deleteKeys = ["one", "two"];
      const stored = yield* files.put("file-key", stream, putOptions);
      const fetched = yield* files.get("file-key", getOptions);
      const deleted = yield* files.delete(deleteKeys);

      assert.strictEqual(stored, r2.object);
      assert.strictEqual(fetched, r2.object);
      assert.strictEqual(fetched?.body, r2.object.body);
      assert.isUndefined(deleted);
      assert.strictEqual(r2.puts[0]?.key, "file-key");
      assert.strictEqual(r2.puts[0]?.value, stream);
      assert.strictEqual(r2.puts[0]?.options, putOptions);
      assert.strictEqual(r2.gets[0]?.options, getOptions);
      assert.strictEqual(r2.deletes[0], deleteKeys);

      const messages: Array<MessageSendRequest<DeletionMessage>> = [
        { body: { jobId: "job-1", cycle: 2 }, delaySeconds: 3 },
      ];
      const queueOptions: QueueSendBatchOptions = { delaySeconds: 5 };
      const sent = yield* queue.sendBatch(messages, queueOptions);
      assert.strictEqual(sent, queueResponse);
      assert.strictEqual(deletionQueue.calls[0]?.messages, messages);
      assert.strictEqual(deletionQueue.calls[0]?.options, queueOptions);

      const workflowOptions: WorkflowInstanceCreateOptions<{ userId: string }> = {
        id: "workflow-1",
        params: { userId: "user-1" },
      };
      const created = yield* workflow.create(workflowOptions);
      const found = yield* workflow.get("workflow-1");
      assert.strictEqual(created, accountWorkflow.instance);
      assert.strictEqual(found, accountWorkflow.instance);
      assert.strictEqual(accountWorkflow.creates[0], workflowOptions);
      assert.strictEqual(accountWorkflow.gets[0], "workflow-1");

      const dataPoint: AnalyticsEngineDataPoint = {
        indexes: ["account"],
        doubles: [1],
        blobs: ["created"],
      };
      const written = yield* analytics.write(dataPoint);
      assert.isUndefined(written);
      assert.strictEqual(analyticsEngine.events[0], dataPoint);

      const rateOptions: RateLimitOptions = { key: "auth:127.0.0.1" };
      const outcome = yield* limiter.limit(rateOptions);
      assert.strictEqual(outcome, rateLimitOutcome);
      assert.strictEqual(rateLimiter.calls[0], rateOptions);
    }),
  );
});

it.effect("maps R2 promise failures with the exact operation and cause", () =>
  Effect.gen(function* () {
    const cause = new Error("R2 unavailable");
    const files = makeR2FileStorage({
      put: () => Promise.reject(cause),
      get: () => Promise.reject(cause),
      delete: () => Promise.reject(cause),
    });
    const stream = new ReadableStream<Uint8Array>();

    const putError = yield* Effect.flip(files.put("key", stream));
    const getError = yield* Effect.flip(files.get("key"));
    const deleteError = yield* Effect.flip(files.delete("key"));

    for (const error of [putError, getError, deleteError]) {
      assert.instanceOf(error, R2FileStorageError);
      assert.strictEqual(error.cause, cause);
    }
    assert.strictEqual(putError.operation, "put");
    assert.strictEqual(getError.operation, "get");
    assert.strictEqual(deleteError.operation, "delete");
  }),
);

it.effect("maps promise and synchronous platform failures to typed errors", () =>
  Effect.gen(function* () {
    const cause = new Error("binding unavailable");
    const queue = makeDeletionQueue({
      sendBatch: (): Promise<QueueSendBatchResponse> => {
        throw cause;
      },
    });
    const workflow = makeAccountWorkflow({
      create: () => Promise.reject(cause),
      get: () => Promise.reject(cause),
    });
    const analytics = makeAnalyticsEngine({
      writeDataPoint: () => {
        throw cause;
      },
    });
    const limiter = makeRateLimiter({
      limit: () => Promise.reject(cause),
    });

    const queueError = yield* Effect.flip(queue.sendBatch([]));
    const createError = yield* Effect.flip(workflow.create());
    const getError = yield* Effect.flip(workflow.get("workflow-1"));
    const analyticsError = yield* Effect.flip(analytics.write());
    const rateLimitError = yield* Effect.flip(limiter.limit({ key: "key" }));

    assert.instanceOf(queueError, DeletionQueueError);
    assert.strictEqual(queueError.operation, "sendBatch");
    assert.strictEqual(queueError.cause, cause);

    for (const error of [createError, getError]) {
      assert.instanceOf(error, AccountWorkflowError);
      assert.strictEqual(error.cause, cause);
    }
    assert.strictEqual(createError.operation, "create");
    assert.strictEqual(getError.operation, "get");

    assert.instanceOf(analyticsError, AnalyticsEngineError);
    assert.strictEqual(analyticsError.operation, "write");
    assert.strictEqual(analyticsError.cause, cause);

    assert.instanceOf(rateLimitError, RateLimiterError);
    assert.strictEqual(rateLimitError.operation, "limit");
    assert.strictEqual(rateLimitError.cause, cause);
  }),
);
