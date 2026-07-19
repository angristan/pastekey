import { Context, Effect, Layer, Schema } from "effect";

import type { AttachmentMetadata, StoredAttachment } from "../../shared/protocol/attachments";
import {
  BrowserCrypto,
  decryptAttachmentContentEffect,
} from "../effect/crypto";
import { browserRuntime } from "../effect/runtime";

export type UnlockedAttachment = {
  stored: StoredAttachment;
  metadata: AttachmentMetadata;
  fileKey: CryptoKey;
};

export type AttachmentPreviewKind = "image" | "audio" | "video" | "text";

export class AttachmentTransportError extends Schema.TaggedErrorClass<AttachmentTransportError>()(
  "AttachmentTransportError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class AttachmentStatusError extends Schema.TaggedErrorClass<AttachmentStatusError>()(
  "AttachmentStatusError",
  {
    message: Schema.String,
    status: Schema.Number,
  },
) {}

export class AttachmentBrowserError extends Schema.TaggedErrorClass<AttachmentBrowserError>()(
  "AttachmentBrowserError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

type AttachmentFetchError = AttachmentTransportError | AttachmentStatusError;

export class AttachmentContent extends Context.Service<AttachmentContent, {
  readonly fetch: (endpoint: string) => Effect.Effect<ArrayBuffer, AttachmentFetchError>;
}>()("pastekey/AttachmentContent") {}

const causeMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const responseErrorMessage = (response: Response) => {
  const fallback = `Download failed (${response.status})`;
  return response.json().then((body: unknown) =>
    typeof body === "object"
      && body !== null
      && "error" in body
      && typeof body.error === "string"
      && body.error.length > 0
      ? body.error
      : fallback
  ).catch(() => fallback);
};

type AttachmentResponse =
  | { readonly success: true; readonly ciphertext: ArrayBuffer }
  | { readonly success: false; readonly message: string; readonly status: number };

const successfulResponse = (ciphertext: ArrayBuffer): AttachmentResponse => ({ success: true, ciphertext });
const failedResponse = (message: string, status: number): AttachmentResponse => ({ success: false, message, status });

export const AttachmentContentLive = Layer.succeed(AttachmentContent)(AttachmentContent.of({
  fetch: Effect.fn("AttachmentContent.fetch")(function*(endpoint: string) {
    const result = yield* Effect.tryPromise({
      try: (signal): Promise<AttachmentResponse> => globalThis.fetch(endpoint, { signal }).then((response) =>
        response.ok
          ? response.arrayBuffer().then(successfulResponse)
          : responseErrorMessage(response).then((message) => failedResponse(message, response.status))
      ),
      catch: (cause) => AttachmentTransportError.make({
        message: causeMessage(cause, "Attachment download failed"),
        cause,
      }),
    });
    if (!result.success) {
      return yield* AttachmentStatusError.make({
        message: result.message,
        status: result.status,
      });
    }
    return result.ciphertext;
  }),
}));

const PREVIEW_IMAGES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-icon",
]);

export function attachmentPreviewKind(type: string): AttachmentPreviewKind | null {
  const mime = type.toLowerCase().split(";", 1)[0]!.trim();
  if (PREVIEW_IMAGES.has(mime)) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") && mime !== "text/html" && mime !== "text/xml") return "text";
  if (mime === "application/json") return "text";
  return null;
}

export const fetchDecryptedAttachmentEffect = Effect.fn("fetchDecryptedAttachment")(function*(
  endpoint: string,
  attachment: UnlockedAttachment,
) {
  const content = yield* AttachmentContent;
  const ciphertext = yield* content.fetch(endpoint);
  const plaintext = yield* decryptAttachmentContentEffect(
    attachment.fileKey,
    attachment.stored,
    ciphertext,
  );
  return yield* Effect.try({
    try: () => new Blob([plaintext], { type: attachment.metadata.type }),
    catch: (cause) => AttachmentBrowserError.make({
      message: causeMessage(cause, "Failed to prepare the decrypted attachment"),
      cause,
    }),
  });
});

export const downloadAttachmentEffect = Effect.fn("downloadAttachment")(function*(
  endpoint: string,
  attachment: UnlockedAttachment,
) {
  const blob = yield* fetchDecryptedAttachmentEffect(endpoint, attachment);
  yield* Effect.try({
    try: () => {
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = attachment.metadata.name;
        link.click();
      } finally {
        try {
          window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        } catch (cause) {
          URL.revokeObjectURL(url);
          throw cause;
        }
      }
    },
    catch: (cause) => AttachmentBrowserError.make({
      message: causeMessage(cause, "Failed to start the attachment download"),
      cause,
    }),
  });
});

const provideAttachmentContent = <A, E>(effect: Effect.Effect<A, E, BrowserCrypto | AttachmentContent>) =>
  effect.pipe(Effect.provide(AttachmentContentLive));

/** Promise adapter retained for browser and React hosts. */
export function fetchDecryptedAttachment(
  endpoint: string,
  attachment: UnlockedAttachment,
  options?: Effect.RunOptions,
): Promise<Blob> {
  return browserRuntime.runPromise(
    provideAttachmentContent(fetchDecryptedAttachmentEffect(endpoint, attachment)),
    options,
  );
}

/** Promise adapter retained for browser event handlers. */
export function downloadAttachment(
  endpoint: string,
  attachment: UnlockedAttachment,
  options?: Effect.RunOptions,
): Promise<void> {
  return browserRuntime.runPromise(
    provideAttachmentContent(downloadAttachmentEffect(endpoint, attachment)),
    options,
  );
}
