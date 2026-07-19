import { Effect, Schedule, Schema } from "effect";

import { ApiStatusError } from "../effect/api";
import { ApiError } from "./api";

const MAX_UPLOAD_ATTEMPTS = 3;

type UploadCallbacks = {
  onProgress: (loaded: number, total: number) => void;
  onRetry: (attempt: number, maxAttempts: number) => void;
  confirmConflict?: () => Promise<boolean>;
};

export class UploadReconciliationError extends Schema.TaggedErrorClass<UploadReconciliationError>()(
  "UploadReconciliationError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const causeMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const statusOf = (cause: unknown) => {
  if (cause instanceof ApiStatusError || cause instanceof ApiError) return cause.status;
  return undefined;
};

const isRetryable = (cause: unknown) => {
  const status = statusOf(cause);
  return status === 0 || status === 408 || status === 425 || status === 429 || status !== undefined && status >= 500;
};

const waitUntilOnline = Effect.fn("waitUntilOnline")(function*() {
  if (
    typeof window === "undefined"
    || typeof navigator === "undefined"
    || navigator.onLine !== false
  ) return;

  const online = Effect.callback<void>((resume) => {
    const onOnline = () => resume(Effect.void);
    window.addEventListener("online", onOnline, { once: true });
    return Effect.sync(() => window.removeEventListener("online", onOnline));
  });

  yield* Effect.raceFirst(online, Effect.sleep("5 seconds"));
});

const responseMessage = (request: XMLHttpRequest) => {
  try {
    const body: unknown = JSON.parse(request.responseText);
    if (
      typeof body === "object"
      && body !== null
      && "error" in body
      && typeof body.error === "string"
      && body.error.length > 0
    ) return body.error;
  } catch {
    // Keep the status-based message when the response has no JSON body.
  }
  return `Upload failed (${request.status})`;
};

export const uploadEffect = Effect.fn("upload")(function*(
  path: string,
  body: XMLHttpRequestBodyInit,
  headers: HeadersInit,
  onProgress: (loaded: number, total: number) => void,
) {
  yield* Effect.callback<void, ApiStatusError>((resume) => {
    let request: XMLHttpRequest;
    try {
      request = new XMLHttpRequest();
      request.open("PUT", path);
      new Headers(headers).forEach((value, name) => request.setRequestHeader(name, value));
    } catch (cause) {
      resume(Effect.fail(ApiStatusError.make({
        message: causeMessage(cause, "Upload could not be started."),
        status: 0,
      })));
      return;
    }

    const finish = (effect: Effect.Effect<void, ApiStatusError>) => {
      cleanup();
      resume(effect);
    };
    const onUploadProgress = (event: ProgressEvent) => {
      onProgress(event.loaded, event.lengthComputable ? event.total : 0);
    };
    const onLoad = () => {
      if (request.status >= 200 && request.status < 300) {
        finish(Effect.void);
        return;
      }
      finish(Effect.fail(ApiStatusError.make({
        message: responseMessage(request),
        status: request.status,
      })));
    };
    const onError = () => finish(Effect.fail(ApiStatusError.make({
      message: "Upload interrupted. Check your connection and retry.",
      status: 0,
    })));
    const onAbort = () => finish(Effect.fail(ApiStatusError.make({
      message: "Upload canceled.",
      status: 0,
    })));
    const cleanup = () => {
      request.upload.removeEventListener("progress", onUploadProgress);
      request.removeEventListener("load", onLoad);
      request.removeEventListener("error", onError);
      request.removeEventListener("abort", onAbort);
    };

    request.upload.addEventListener("progress", onUploadProgress);
    request.addEventListener("load", onLoad);
    request.addEventListener("error", onError);
    request.addEventListener("abort", onAbort);

    try {
      request.send(body);
    } catch (cause) {
      finish(Effect.fail(ApiStatusError.make({
        message: causeMessage(cause, "Upload could not be sent."),
        status: 0,
      })));
    }

    return Effect.sync(() => {
      cleanup();
      request.abort();
    });
  });
});

const reconcileConflict = Effect.fn("reconcileUploadConflict")(function*(
  error: ApiStatusError,
  confirmConflict: (() => Promise<boolean>) | undefined,
) {
  if (error.status !== 409 || confirmConflict === undefined) return yield* error;

  const confirmed = yield* Effect.tryPromise({
    try: () => confirmConflict(),
    catch: (cause) => UploadReconciliationError.make({
      message: causeMessage(cause, "Failed to confirm the uploaded attachment."),
      cause,
    }),
  });
  if (!confirmed) return yield* error;
});

export const uploadWithRetryEffect = Effect.fn("uploadWithRetry")(function*(
  path: string,
  body: XMLHttpRequestBodyInit,
  headers: HeadersInit,
  callbacks: UploadCallbacks,
) {
  const retrySchedule = Schedule.exponential("500 millis").pipe(
    Schedule.upTo({ times: MAX_UPLOAD_ATTEMPTS - 1 }),
    Schedule.tap(({ attempt }) => waitUntilOnline().pipe(
      Effect.tap(() => Effect.sync(() => callbacks.onRetry(attempt + 1, MAX_UPLOAD_ATTEMPTS))),
    )),
  );

  yield* uploadEffect(path, body, headers, callbacks.onProgress).pipe(
    Effect.catch((error) => reconcileConflict(error, callbacks.confirmConflict)),
    Effect.retry({
      schedule: retrySchedule,
      while: isRetryable,
    }),
  );
});

/** Promise adapter retained while browser callers migrate to Effect. */
export function uploadWithRetry(
  path: string,
  body: XMLHttpRequestBodyInit,
  headers: HeadersInit,
  callbacks: UploadCallbacks,
): Promise<void> {
  return Effect.runPromise(uploadWithRetryEffect(path, body, headers, callbacks));
}
