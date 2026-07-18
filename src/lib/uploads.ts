import { ApiError } from "./api";

const MAX_UPLOAD_ATTEMPTS = 3;

type UploadCallbacks = {
  onProgress: (loaded: number, total: number) => void;
  onRetry: (attempt: number, maxAttempts: number) => void;
};

export async function uploadWithRetry(
  path: string,
  body: XMLHttpRequestBodyInit,
  headers: HeadersInit,
  callbacks: UploadCallbacks,
) {
  let retriedAfterIndeterminateResult = false;

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      await upload(path, body, headers, callbacks.onProgress);
      return;
    } catch (cause) {
      // The server may have persisted the file even when its success response was lost.
      if (cause instanceof ApiError && cause.status === 409 && retriedAfterIndeterminateResult) return;
      if (!isRetryable(cause) || attempt === MAX_UPLOAD_ATTEMPTS) throw cause;

      retriedAfterIndeterminateResult = true;
      callbacks.onRetry(attempt + 1, MAX_UPLOAD_ATTEMPTS);
      await waitBeforeRetry(attempt);
    }
  }
}

function upload(
  path: string,
  body: XMLHttpRequestBodyInit,
  headers: HeadersInit,
  onProgress: (loaded: number, total: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", path);
    new Headers(headers).forEach((value, name) => request.setRequestHeader(name, value));

    request.upload.addEventListener("progress", (event) => {
      onProgress(event.loaded, event.lengthComputable ? event.total : 0);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      reject(new ApiError(responseMessage(request), request.status));
    });
    request.addEventListener("error", () => reject(new ApiError("Upload interrupted. Check your connection and retry.", 0)));
    request.addEventListener("abort", () => reject(new ApiError("Upload canceled.", 0)));
    request.send(body);
  });
}

function responseMessage(request: XMLHttpRequest) {
  try {
    const body = JSON.parse(request.responseText) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Keep the status-based message when the response has no JSON body.
  }
  return `Upload failed (${request.status})`;
}

function isRetryable(cause: unknown) {
  if (!(cause instanceof ApiError)) return false;
  return cause.status === 0 || cause.status === 408 || cause.status === 425 || cause.status === 429 || cause.status >= 500;
}

async function waitBeforeRetry(attempt: number) {
  if (typeof window !== "undefined" && typeof navigator !== "undefined" && navigator.onLine === false) {
    await Promise.race([
      new Promise<void>((resolve) => window.addEventListener("online", () => resolve(), { once: true })),
      delay(5_000),
    ]);
  }
  await delay(500 * (2 ** (attempt - 1)));
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
