import { describe, expect, it, vi } from "vitest";

import {
  traceWorkerOperation,
  type WorkerTracing,
} from "./tracing";

function tracingRecorder() {
  const attributes = new Map<string, boolean | number | string | undefined>();
  const setAttribute = vi.fn((key: string, value?: boolean | number | string) => {
    attributes.set(key, value);
  });
  const enteredName = vi.fn<(name: string) => void>();
  const provider: WorkerTracing = {
    enterSpan: <A>(
      name: string,
      callback: (span: { setAttribute: typeof setAttribute }) => Promise<A>,
    ) => {
      enteredName(name);
      return callback({ setAttribute });
    },
  };
  return {
    attributes,
    enteredName,
    provider,
    setAttribute,
  };
}

describe("Worker custom tracing", () => {
  it("records only bounded operational context", async () => {
    const recorder = tracingRecorder();

    await expect(traceWorkerOperation({
      name: "pastekey.deletion.queue.consume",
      trigger: "queue",
      queueKind: "primary",
      batchSize: 10,
    }, async () => "done", recorder.provider)).resolves.toBe("done");

    expect(recorder.enteredName).toHaveBeenCalledWith(
      "pastekey.deletion.queue.consume",
    );
    expect(Object.fromEntries(recorder.attributes)).toEqual({
      "pastekey.batch.size": 10,
      "pastekey.queue.kind": "primary",
      "pastekey.trigger": "queue",
    });
  });

  it("marks failures without recording causes", async () => {
    const recorder = tracingRecorder();
    const failure = new Error("sensitive provider detail");

    await expect(traceWorkerOperation({
      name: "pastekey.attachment.upload",
      trigger: "http",
    }, async () => {
      throw failure;
    }, recorder.provider)).rejects.toBe(failure);

    expect(Object.fromEntries(recorder.attributes)).toEqual({
      "pastekey.failed": true,
      "pastekey.trigger": "http",
    });
    expect(recorder.setAttribute).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("sensitive"),
    );
  });

  it("omits invalid batch sizes", async () => {
    const recorder = tracingRecorder();

    await traceWorkerOperation({
      name: "pastekey.deletion.queue.consume",
      trigger: "queue",
      batchSize: Number.NaN,
    }, async () => undefined, recorder.provider);

    expect(recorder.attributes.has("pastekey.batch.size")).toBe(false);
  });
});
