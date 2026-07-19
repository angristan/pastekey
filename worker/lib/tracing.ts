import { tracing } from "cloudflare:workers";

export const WorkerSpanName = [
  "pastekey.account.deletion.request",
  "pastekey.account.deletion.reconcile",
  "pastekey.attachment.upload",
  "pastekey.auth.login.verify",
  "pastekey.auth.registration.verify",
  "pastekey.cleanup.expired",
  "pastekey.deletion.queue.consume",
  "pastekey.lifecycle.metrics.record",
] as const;
export type WorkerSpanName = typeof WorkerSpanName[number];

export type WorkerSpanTrigger = "http" | "queue" | "scheduled";
export type WorkerQueueKind = "dead-letter" | "primary" | "unknown";

export interface WorkerSpanOptions {
  readonly name: WorkerSpanName;
  readonly trigger: WorkerSpanTrigger;
  readonly queueKind?: WorkerQueueKind;
  readonly batchSize?: number;
}

interface WorkerSpanSink {
  readonly setAttribute: (key: string, value?: boolean | number | string) => void;
}

export interface WorkerTracing {
  readonly enterSpan: <A>(
    name: string,
    callback: (span: WorkerSpanSink) => Promise<A>,
  ) => Promise<A>;
}

const nativeTracing: WorkerTracing = tracing;

/** Adds one bounded, identifier-free span around a Worker host operation. */
export function traceWorkerOperation<A>(
  options: WorkerSpanOptions,
  task: () => Promise<A>,
  provider: WorkerTracing = nativeTracing,
): Promise<A> {
  return provider.enterSpan(options.name, async (span) => {
    span.setAttribute("pastekey.trigger", options.trigger);
    if (options.queueKind !== undefined) {
      span.setAttribute("pastekey.queue.kind", options.queueKind);
    }
    if (
      options.batchSize !== undefined
      && Number.isSafeInteger(options.batchSize)
      && options.batchSize >= 0
    ) {
      span.setAttribute("pastekey.batch.size", options.batchSize);
    }

    try {
      return await task();
    } catch (cause) {
      span.setAttribute("pastekey.failed", true);
      throw cause;
    }
  });
}
