import { Effect, Result, Schema } from "effect";
import { useEffect, useRef, useState } from "react";

import type { StoredAttachment } from "../../../shared/protocol/attachments";
import { AttachmentListResponse, NoContentResponse } from "../../../shared/schema/api";
import { ApiStatusError } from "../../effect/api";
import { requestApi, runClientPromise } from "../../effect/runtime";
import { encryptAttachment } from "../../lib/crypto";
import { messageOf } from "../../lib/format";
import { uploadWithRetry, uploadWithRetryEffect } from "../../lib/uploads";

type UploadPhase = "pending" | "encrypting" | "uploading" | "retrying" | "complete" | "error";
type EncryptedAttachment = Awaited<ReturnType<typeof encryptAttachment>>;

export type SelectedFile = {
  id: string;
  file: File;
  phase: UploadPhase;
  progress: number;
  attempt?: number;
  maxAttempts?: number;
  error?: string;
};

export type UploadSession = {
  pasteId: string;
  pasteKey: CryptoKey;
};

export type UploadPayloadCache = ReturnType<typeof createUploadPayloadCache>;

type UploadDependencies = {
  encrypt: typeof encryptAttachment;
  upload: typeof uploadWithRetry;
  list: (pasteId: string) => Promise<StoredAttachment[]>;
};

export class UploadOperationError extends Schema.TaggedErrorClass<UploadOperationError>()(
  "UploadOperationError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const causeMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const fromUploadPromise = <A>(operation: () => PromiseLike<A>) => Effect.tryPromise({
  try: operation,
  catch: (cause) => UploadOperationError.make({
    message: causeMessage(cause, "Upload operation failed."),
    cause,
  }),
});

const compatibleApiError = (cause: unknown) => {
  if (cause instanceof ApiStatusError) return cause;
  return UploadOperationError.make({
    message: causeMessage(cause, "Failed to discard the upload session."),
    cause,
  });
};

const isMissingApiError = (cause: unknown) =>
  cause instanceof ApiStatusError && cause.status === 404;

const defaultDependencies: UploadDependencies = {
  encrypt: encryptAttachment,
  upload: uploadWithRetry,
  list: async (pasteId) => {
    const response = await requestApi(`/api/pastes/${pasteId}/files`, AttachmentListResponse);
    return response.attachments;
  },
};

let nextSelectionId = 0;

const makeSelectedFile = (file: File): SelectedFile => ({
  id: `selected-${Date.now()}-${nextSelectionId++}`,
  file,
  phase: "pending",
  progress: 0,
});

export function useUploadSession() {
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [session, setSession] = useState<UploadSession | null>(null);
  const payloads = useRef(createUploadPayloadCache());

  useEffect(() => () => payloads.current.clear(), []);

  function appendFiles(selected: File[]) {
    setFiles((current) => [
      ...current,
      ...selected.map(makeSelectedFile),
    ]);
  }

  function removeFile(id: string) {
    payloads.current.release(id);
    setFiles((current) => current.filter((item) => item.id !== id));
  }

  function updateFile(id: string, patch: Partial<SelectedFile>) {
    setFiles((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function uploadFile(selected: SelectedFile, uploadSession: UploadSession) {
    return uploadSelectedFile({
      selected,
      session: uploadSession,
      payloads: payloads.current,
      update: (patch) => updateFile(selected.id, patch),
    });
  }

  function beginSession(uploadSession: UploadSession) {
    setSession(uploadSession);
  }

  function finishSession() {
    payloads.current.clear();
    setSession(null);
  }

  return {
    appendFiles,
    beginSession,
    files,
    finishSession,
    removeFile,
    session,
    uploadFile,
  };
}

type UploadSelectedFileInput = {
  selected: SelectedFile;
  session: UploadSession;
  payloads: UploadPayloadCache;
  update: (patch: Partial<SelectedFile>) => void;
  dependencies?: UploadDependencies;
};

export const uploadSelectedFileEffect = Effect.fn("uploadSelectedFile")(function*({
  selected,
  session,
  payloads,
  update,
  dependencies: providedDependencies,
}: UploadSelectedFileInput) {
  const dependencies = providedDependencies ?? defaultDependencies;

  yield* Effect.sync(() => update({
    progress: 0,
    error: undefined,
    attempt: undefined,
    maxAttempts: undefined,
  }));

  const operation = Effect.gen(function*() {
    let attachment = payloads.get(selected.id);
    if (attachment === undefined) {
      yield* Effect.sync(() => update({ phase: "encrypting" }));
      attachment = yield* fromUploadPromise(() => dependencies.encrypt(
        session.pasteKey,
        session.pasteId,
        selected.file,
      ));
      payloads.retain(selected.id, attachment);
    }

    const retainedAttachment = attachment;
    const path = `/api/pastes/${session.pasteId}/files/${retainedAttachment.id}`;
    const callbacks = {
      onProgress: (loaded: number, reportedTotal: number) => {
        const total = reportedTotal || retainedAttachment.body.byteLength;
        update({
          phase: "uploading",
          progress: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
        });
      },
      onRetry: (attempt: number, maxAttempts: number) => update({
        phase: "retrying",
        progress: 0,
        attempt,
        maxAttempts,
      }),
      confirmConflict: async () => {
        const attachments = await dependencies.list(session.pasteId);
        return attachments.some(({ id }) => id === retainedAttachment.id);
      },
    };

    yield* Effect.sync(() => update({ phase: "uploading" }));
    yield* providedDependencies === undefined
      ? uploadWithRetryEffect(path, retainedAttachment.body, retainedAttachment.headers, callbacks)
      : fromUploadPromise(() => dependencies.upload(
        path,
        retainedAttachment.body,
        retainedAttachment.headers,
        callbacks,
      ));
  });

  const result = yield* Effect.result(operation);
  if (Result.isFailure(result)) {
    yield* Effect.sync(() => update({
      phase: "error",
      progress: 0,
      error: messageOf(result.failure),
    }));
    return false;
  }

  payloads.release(selected.id);
  yield* Effect.sync(() => update({
    phase: "complete",
    progress: 100,
    attempt: undefined,
    maxAttempts: undefined,
  }));
  return true;
});

/** Promise adapter retained for React event handlers. */
export function uploadSelectedFile(input: UploadSelectedFileInput): Promise<boolean> {
  return runClientPromise(uploadSelectedFileEffect(input));
}

export const uploadUntilFailureEffect: <E, R>(
  files: readonly SelectedFile[],
  upload: (file: SelectedFile) => Effect.Effect<boolean, E, R>,
) => Effect.Effect<{
  attemptedIds: Set<string>;
  failedIds: Set<string>;
}, E, R> = Effect.fn("uploadUntilFailure")(function*<E, R>(
  files: readonly SelectedFile[],
  upload: (file: SelectedFile) => Effect.Effect<boolean, E, R>,
) {
  const attemptedIds = new Set<string>();
  const failedIds = new Set<string>();
  yield* Effect.forEach(files, (file) => {
    if (failedIds.size > 0) return Effect.void;
    return Effect.sync(() => attemptedIds.add(file.id)).pipe(
      Effect.andThen(upload(file)),
      Effect.tap((succeeded) => Effect.sync(() => {
        if (!succeeded) failedIds.add(file.id);
      })),
      Effect.asVoid,
    );
  }, { concurrency: 1, discard: true });
  return { attemptedIds, failedIds };
});

/** Promise adapter retained for React event handlers. */
export function uploadUntilFailure(
  files: readonly SelectedFile[],
  upload: (file: SelectedFile) => Promise<boolean>,
): Promise<{ attemptedIds: Set<string>; failedIds: Set<string> }> {
  return runClientPromise(uploadUntilFailureEffect(
    files,
    (file) => fromUploadPromise(() => upload(file)),
  ));
}

export const discardUploadSessionEffect = Effect.fn("discardUploadSession")(function*<E, R>(
  pasteId: string,
  remove: (pasteId: string) => Effect.Effect<void, E, R>,
) {
  yield* remove(pasteId).pipe(
    Effect.catchIf(isMissingApiError, () => Effect.void),
  );
});

/** Promise adapter retained for React event handlers. */
export function discardUploadSession(
  pasteId: string,
  remove: (pasteId: string) => Promise<void> = async (id) => {
    await requestApi(`/api/pastes/${id}`, NoContentResponse, { method: "DELETE" });
  },
): Promise<void> {
  return runClientPromise(discardUploadSessionEffect(
    pasteId,
    (id) => Effect.tryPromise({
      try: () => remove(id),
      catch: compatibleApiError,
    }),
  ));
}

export function createUploadPayloadCache() {
  const payloads = new Map<string, EncryptedAttachment>();
  return {
    get(id: string) {
      return payloads.get(id);
    },
    retain(id: string, payload: EncryptedAttachment) {
      payloads.set(id, payload);
    },
    release(id: string) {
      payloads.delete(id);
    },
    clear() {
      payloads.clear();
    },
    get size() {
      return payloads.size;
    },
  };
}
