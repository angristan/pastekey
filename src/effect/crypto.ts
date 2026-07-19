import { Context, Effect, Layer, Schema } from "effect";

import type { WrappedKey } from "../../shared/protocol/auth";
import type { AttachmentMetadata, StoredAttachment } from "../../shared/protocol/attachments";
import { AttachmentMetadata as AttachmentMetadataSchema } from "../../shared/schema/attachments";
import type { PastePayload, StoredPaste, StoredShare } from "../../shared/protocol/pastes";
import { PastePayload as PastePayloadSchema } from "../../shared/schema/pastes";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const AES_GCM = { name: "AES-GCM", length: 256 };
export const PASTE_KEY_USAGES: KeyUsage[] = ["encrypt", "decrypt", "wrapKey", "unwrapKey"];
export const PRF_INPUT = encoder.encode("pastekey/passkey-prf/v1");

export const CryptoOperation = Schema.Literals([
  "decrypt",
  "derive-key",
  "encrypt",
  "file-read",
  "generate-key",
  "random-values",
  "unwrap-key",
  "wrap-key",
]);
export type CryptoOperation = typeof CryptoOperation.Type;

export class BrowserCryptoError extends Schema.TaggedErrorClass<BrowserCryptoError>()(
  "BrowserCryptoError",
  {
    operation: CryptoOperation,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CryptoValidationError extends Schema.TaggedErrorClass<CryptoValidationError>()(
  "CryptoValidationError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export type CryptoWorkflowError = BrowserCryptoError | CryptoValidationError;

const causeMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const cryptoFailure = (operation: CryptoOperation, fallback: string) => (cause: unknown) =>
  BrowserCryptoError.make({
    operation,
    message: causeMessage(cause, fallback),
    cause,
  });

export class BrowserCrypto extends Context.Service<BrowserCrypto, {
  readonly randomBytes: (length: number) => Effect.Effect<Uint8Array<ArrayBuffer>, BrowserCryptoError>;
  readonly generateAesKey: (
    extractable: boolean,
    usages: KeyUsage[],
  ) => Effect.Effect<CryptoKey, BrowserCryptoError>;
  readonly deriveAesKey: (
    material: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    info: Uint8Array<ArrayBuffer>,
    usages: KeyUsage[],
  ) => Effect.Effect<CryptoKey, BrowserCryptoError>;
  readonly encrypt: (
    key: CryptoKey,
    plaintext: Uint8Array<ArrayBuffer>,
    iv: Uint8Array<ArrayBuffer>,
    additionalData: Uint8Array<ArrayBuffer>,
  ) => Effect.Effect<ArrayBuffer, BrowserCryptoError>;
  readonly decrypt: (
    key: CryptoKey,
    ciphertext: Uint8Array<ArrayBuffer>,
    iv: Uint8Array<ArrayBuffer>,
    additionalData: Uint8Array<ArrayBuffer>,
  ) => Effect.Effect<ArrayBuffer, BrowserCryptoError>;
  readonly wrapKey: (
    key: CryptoKey,
    wrappingKey: CryptoKey,
    iv: Uint8Array<ArrayBuffer>,
    additionalData: Uint8Array<ArrayBuffer>,
  ) => Effect.Effect<ArrayBuffer, BrowserCryptoError>;
  readonly unwrapKey: (
    ciphertext: Uint8Array<ArrayBuffer>,
    iv: Uint8Array<ArrayBuffer>,
    wrappingKey: CryptoKey,
    additionalData: Uint8Array<ArrayBuffer>,
    usages: KeyUsage[],
  ) => Effect.Effect<CryptoKey, BrowserCryptoError>;
  readonly readFile: (file: File) => Effect.Effect<ArrayBuffer, BrowserCryptoError>;
}>()("pastekey/BrowserCrypto") {}

const makeBrowserCrypto = () => BrowserCrypto.of({
  randomBytes: Effect.fn("BrowserCrypto.randomBytes")(function*(length: number) {
    return yield* Effect.try({
      try: () => globalThis.crypto.getRandomValues(new Uint8Array(length)),
      catch: cryptoFailure("random-values", "Failed to generate secure random bytes"),
    });
  }),
  generateAesKey: Effect.fn("BrowserCrypto.generateAesKey")(function*(
    extractable: boolean,
    usages: KeyUsage[],
  ) {
    return yield* Effect.tryPromise({
      try: () => globalThis.crypto.subtle.generateKey(AES_GCM, extractable, usages),
      catch: cryptoFailure("generate-key", "Failed to generate an AES key"),
    });
  }),
  deriveAesKey: Effect.fn("BrowserCrypto.deriveAesKey")(function*(
    material: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    info: Uint8Array<ArrayBuffer>,
    usages: KeyUsage[],
  ) {
    const inputKey = yield* Effect.tryPromise({
      try: () => globalThis.crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]),
      catch: cryptoFailure("derive-key", "Failed to import HKDF key material"),
    });
    return yield* Effect.tryPromise({
      try: () => globalThis.crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info },
        inputKey,
        AES_GCM,
        false,
        usages,
      ),
      catch: cryptoFailure("derive-key", "Failed to derive an AES key"),
    });
  }),
  encrypt: Effect.fn("BrowserCrypto.encrypt")(function*(
    key: CryptoKey,
    plaintext: Uint8Array<ArrayBuffer>,
    iv: Uint8Array<ArrayBuffer>,
    additionalData: Uint8Array<ArrayBuffer>,
  ) {
    return yield* Effect.tryPromise({
      try: () => globalThis.crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData },
        key,
        plaintext,
      ),
      catch: cryptoFailure("encrypt", "Failed to encrypt data"),
    });
  }),
  decrypt: Effect.fn("BrowserCrypto.decrypt")(function*(
    key: CryptoKey,
    ciphertext: Uint8Array<ArrayBuffer>,
    iv: Uint8Array<ArrayBuffer>,
    additionalData: Uint8Array<ArrayBuffer>,
  ) {
    return yield* Effect.tryPromise({
      try: () => globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData },
        key,
        ciphertext,
      ),
      catch: cryptoFailure("decrypt", "Failed to decrypt data"),
    });
  }),
  wrapKey: Effect.fn("BrowserCrypto.wrapKey")(function*(
    key: CryptoKey,
    wrappingKey: CryptoKey,
    iv: Uint8Array<ArrayBuffer>,
    additionalData: Uint8Array<ArrayBuffer>,
  ) {
    return yield* Effect.tryPromise({
      try: () => globalThis.crypto.subtle.wrapKey(
        "raw",
        key,
        wrappingKey,
        { name: "AES-GCM", iv, additionalData },
      ),
      catch: cryptoFailure("wrap-key", "Failed to wrap a key"),
    });
  }),
  unwrapKey: Effect.fn("BrowserCrypto.unwrapKey")(function*(
    ciphertext: Uint8Array<ArrayBuffer>,
    iv: Uint8Array<ArrayBuffer>,
    wrappingKey: CryptoKey,
    additionalData: Uint8Array<ArrayBuffer>,
    usages: KeyUsage[],
  ) {
    return yield* Effect.tryPromise({
      try: () => globalThis.crypto.subtle.unwrapKey(
        "raw",
        ciphertext,
        wrappingKey,
        { name: "AES-GCM", iv, additionalData },
        AES_GCM,
        true,
        usages,
      ),
      catch: cryptoFailure("unwrap-key", "Failed to unwrap a key"),
    });
  }),
  readFile: Effect.fn("BrowserCrypto.readFile")(function*(file: File) {
    return yield* Effect.tryPromise({
      try: () => file.arrayBuffer(),
      catch: cryptoFailure("file-read", "Failed to read the attachment"),
    });
  }),
});

export const BrowserCryptoLive = Layer.succeed(BrowserCrypto)(makeBrowserCrypto());

export function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomId(bytes = 16) {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

const isByteArray = (value: unknown): value is ReadonlyArray<number> =>
  Array.isArray(value)
  && value.every((byte: unknown) => Number.isInteger(byte) && typeof byte === "number" && byte >= 0 && byte <= 255);

export function normalizePrfOutput(value: unknown): Uint8Array<ArrayBuffer> {
  let source: Uint8Array<ArrayBufferLike>;

  if (value instanceof ArrayBuffer) {
    source = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (typeof value === "string") {
    source = fromBase64Url(value);
  } else if (isByteArray(value)) {
    source = Uint8Array.from(value);
  } else if (Array.isArray(value)) {
    throw new Error("WebAuthn PRF returned an invalid byte array");
  } else {
    throw new Error(`WebAuthn PRF returned unsupported key data (${Object.prototype.toString.call(value)})`);
  }

  if (source.byteLength !== 32) {
    throw new Error(`WebAuthn PRF returned ${source.byteLength} bytes; expected 32`);
  }

  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

const decodeBase64Url = (value: string) => Effect.try({
  try: () => fromBase64Url(value),
  catch: (cause) => CryptoValidationError.make({
    message: causeMessage(cause, "Invalid base64url value"),
    cause,
  }),
});

const encodeJson = (value: unknown) => Effect.try({
  try: () => encoder.encode(JSON.stringify(value)),
  catch: (cause) => CryptoValidationError.make({
    message: "Failed to encode encrypted data",
    cause,
  }),
});

const parseJson = (plaintext: Uint8Array<ArrayBuffer>) => Effect.try({
  try: (): unknown => JSON.parse(decoder.decode(plaintext)),
  catch: (cause) => CryptoValidationError.make({
    message: "Invalid encrypted JSON",
    cause,
  }),
});

const preserveDecodedProperties = <A extends object>(decoded: A, input: unknown): A =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? Object.assign({}, input, decoded)
    : decoded;

export const encryptBytesEffect = Effect.fn("encryptBytes")(function*(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  additionalData: string,
) {
  const browserCrypto = yield* BrowserCrypto;
  const iv = yield* browserCrypto.randomBytes(12);
  const ciphertext = new Uint8Array(yield* browserCrypto.encrypt(
    key,
    plaintext,
    iv,
    encoder.encode(additionalData),
  ));
  return {
    ciphertext,
    encodedCiphertext: toBase64Url(ciphertext),
    iv: toBase64Url(iv),
  };
});

export const decryptBytesEffect = Effect.fn("decryptBytes")(function*(
  key: CryptoKey,
  ciphertext: Uint8Array<ArrayBuffer>,
  encodedIv: string,
  additionalData: string,
) {
  const browserCrypto = yield* BrowserCrypto;
  const iv = yield* decodeBase64Url(encodedIv);
  return new Uint8Array(yield* browserCrypto.decrypt(
    key,
    ciphertext,
    iv,
    encoder.encode(additionalData),
  ));
});

export const wrapKeyEffect = Effect.fn("wrapKey")(function*(
  key: CryptoKey,
  wrappingKey: CryptoKey,
  additionalData: string,
) {
  const browserCrypto = yield* BrowserCrypto;
  const iv = yield* browserCrypto.randomBytes(12);
  const ciphertext = yield* browserCrypto.wrapKey(key, wrappingKey, iv, encoder.encode(additionalData));
  return { ciphertext: toBase64Url(new Uint8Array(ciphertext)), iv: toBase64Url(iv) };
});

export const unwrapKeyEffect = Effect.fn("unwrapKey")(function*(
  envelope: WrappedKey,
  wrappingKey: CryptoKey,
  additionalData: string,
  usages: KeyUsage[] = ["encrypt", "decrypt"],
) {
  const browserCrypto = yield* BrowserCrypto;
  const ciphertext = yield* decodeBase64Url(envelope.ciphertext);
  const iv = yield* decodeBase64Url(envelope.iv);
  return yield* browserCrypto.unwrapKey(
    ciphertext,
    iv,
    wrappingKey,
    encoder.encode(additionalData),
    usages,
  );
});

export const generateAccountKeyEffect = Effect.fn("generateAccountKey")(function*() {
  const browserCrypto = yield* BrowserCrypto;
  return yield* browserCrypto.generateAesKey(true, PASTE_KEY_USAGES);
});

export const derivePasskeyWrappingKeyEffect = Effect.fn("derivePasskeyWrappingKey")(function*(prfOutput: unknown) {
  const material = yield* Effect.try({
    try: () => normalizePrfOutput(prfOutput),
    catch: (cause) => CryptoValidationError.make({
      message: causeMessage(cause, "Invalid WebAuthn PRF output"),
      cause,
    }),
  });
  const browserCrypto = yield* BrowserCrypto;
  return yield* browserCrypto.deriveAesKey(
    material,
    encoder.encode("pastekey/passkey-kek/salt/v1"),
    encoder.encode("pastekey/account-key/wrapping/v1"),
    ["wrapKey", "unwrapKey"],
  );
});

export const wrapAccountKeyEffect = Effect.fn("wrapAccountKey")(function*(
  accountKey: CryptoKey,
  passkeyKey: CryptoKey,
  credentialId: string,
) {
  return yield* wrapKeyEffect(accountKey, passkeyKey, `pastekey/account/${credentialId}/v1`);
});

export const unwrapAccountKeyEffect = Effect.fn("unwrapAccountKey")(function*(
  envelope: WrappedKey,
  passkeyKey: CryptoKey,
  credentialId: string,
) {
  return yield* unwrapKeyEffect(
    envelope,
    passkeyKey,
    `pastekey/account/${credentialId}/v1`,
    PASTE_KEY_USAGES,
  );
});

const deriveShareKeyEffect = Effect.fn("deriveShareKey")(function*(
  secret: Uint8Array<ArrayBuffer>,
  shareId: string,
  pasteId: string,
) {
  const browserCrypto = yield* BrowserCrypto;
  return yield* browserCrypto.deriveAesKey(
    secret,
    encoder.encode(`pastekey/share/${shareId}/salt/v1`),
    encoder.encode(`pastekey/share/${pasteId}/wrapping/v1`),
    ["wrapKey", "unwrapKey"],
  );
});

const encryptPayloadEffect = Effect.fn("encryptPayload")(function*(
  key: CryptoKey,
  id: string,
  payload: PastePayload,
) {
  const plaintext = yield* encodeJson(payload);
  const encrypted = yield* encryptBytesEffect(key, plaintext, `pastekey/paste/${id}/v1`);
  return { ciphertext: encrypted.encodedCiphertext, iv: encrypted.iv };
});

const decryptPayloadEffect = Effect.fn("decryptPayload")(function*(
  key: CryptoKey,
  id: string,
  ciphertext: string,
  encodedIv: string,
) {
  const decodedCiphertext = yield* decodeBase64Url(ciphertext);
  const plaintext = yield* decryptBytesEffect(key, decodedCiphertext, encodedIv, `pastekey/paste/${id}/v1`);
  const value = yield* parseJson(plaintext);
  return yield* Schema.decodeUnknownEffect(PastePayloadSchema)(value).pipe(
    Effect.map((decoded) => preserveDecodedProperties(decoded, value)),
    Effect.mapError((cause) => CryptoValidationError.make({
      message: "Invalid encrypted paste payload",
      cause,
    })),
  );
});

export const encryptNewPasteEffect = Effect.fn("encryptNewPaste")(function*(
  accountKey: CryptoKey,
  payload: PastePayload,
  expiresAt: number | null,
) {
  const browserCrypto = yield* BrowserCrypto;
  const id = toBase64Url(yield* browserCrypto.randomBytes(16));
  const pasteKey = yield* browserCrypto.generateAesKey(true, PASTE_KEY_USAGES);
  const encrypted = yield* encryptPayloadEffect(pasteKey, id, payload);
  const wrapped = yield* wrapKeyEffect(pasteKey, accountKey, `pastekey/owner/${id}/v1`);

  return {
    pasteKey,
    write: {
      id,
      ciphertext: encrypted.ciphertext,
      contentIv: encrypted.iv,
      wrappedKey: wrapped.ciphertext,
      wrappedKeyIv: wrapped.iv,
      expiresAt,
    },
  };
});

export const encryptExistingPasteEffect = Effect.fn("encryptExistingPaste")(function*(
  accountKey: CryptoKey,
  pasteKey: CryptoKey,
  id: string,
  payload: PastePayload,
  expiresAt: number | null,
) {
  const encrypted = yield* encryptPayloadEffect(pasteKey, id, payload);
  const wrapped = yield* wrapKeyEffect(pasteKey, accountKey, `pastekey/owner/${id}/v1`);
  return {
    ciphertext: encrypted.ciphertext,
    contentIv: encrypted.iv,
    wrappedKey: wrapped.ciphertext,
    wrappedKeyIv: wrapped.iv,
    expiresAt,
  };
});

export const decryptOwnedPasteEffect = Effect.fn("decryptOwnedPaste")(function*(
  accountKey: CryptoKey,
  stored: StoredPaste,
) {
  const pasteKey = yield* unwrapKeyEffect(
    { ciphertext: stored.wrappedKey, iv: stored.wrappedKeyIv },
    accountKey,
    `pastekey/owner/${stored.id}/v1`,
    PASTE_KEY_USAGES,
  );
  const payload = yield* decryptPayloadEffect(pasteKey, stored.id, stored.ciphertext, stored.contentIv);
  return { pasteKey, payload };
});

export const createShareEnvelopeEffect = Effect.fn("createShareEnvelope")(function*(
  pasteId: string,
  pasteKey: CryptoKey,
  expiresAt: number | null,
) {
  const browserCrypto = yield* BrowserCrypto;
  const id = toBase64Url(yield* browserCrypto.randomBytes(16));
  const secret = yield* browserCrypto.randomBytes(32);
  const shareKey = yield* deriveShareKeyEffect(secret, id, pasteId);
  const wrapped = yield* wrapKeyEffect(pasteKey, shareKey, `pastekey/share/${id}/${pasteId}/v1`);

  return {
    secret: toBase64Url(secret),
    write: {
      id,
      wrappedKey: wrapped.ciphertext,
      wrappedKeyIv: wrapped.iv,
      expiresAt,
    },
  };
});

export const decryptSharedPasteEffect = Effect.fn("decryptSharedPaste")(function*(
  stored: StoredShare,
  encodedSecret: string,
) {
  const secret = yield* decodeBase64Url(encodedSecret);
  if (secret.byteLength !== 32) {
    return yield* CryptoValidationError.make({ message: "Invalid share secret" });
  }

  const shareKey = yield* deriveShareKeyEffect(secret, stored.id, stored.pasteId);
  const pasteKey = yield* unwrapKeyEffect(
    { ciphertext: stored.wrappedKey, iv: stored.wrappedKeyIv },
    shareKey,
    `pastekey/share/${stored.id}/${stored.pasteId}/v1`,
    PASTE_KEY_USAGES,
  );
  const payload = yield* decryptPayloadEffect(pasteKey, stored.pasteId, stored.ciphertext, stored.contentIv);
  return { pasteKey, payload };
});

export const encryptAttachmentEffect = Effect.fn("encryptAttachment")(function*(
  pasteKey: CryptoKey,
  pasteId: string,
  file: File,
) {
  const browserCrypto = yield* BrowserCrypto;
  const id = toBase64Url(yield* browserCrypto.randomBytes(16));
  const fileKey = yield* browserCrypto.generateAesKey(true, ["encrypt", "decrypt"]);
  const wrapped = yield* wrapKeyEffect(fileKey, pasteKey, `pastekey/file/${id}/${pasteId}/v1`);
  const metadataPlaintext = yield* encodeJson({
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
  });
  const metadata = yield* encryptBytesEffect(
    fileKey,
    metadataPlaintext,
    `pastekey/file-metadata/${id}/${pasteId}/v1`,
  );
  const contentBuffer = yield* browserCrypto.readFile(file);
  const content = yield* encryptBytesEffect(
    fileKey,
    new Uint8Array(contentBuffer),
    `pastekey/file-content/${id}/${pasteId}/v1`,
  );

  return {
    id,
    body: content.ciphertext,
    headers: {
      "X-Pastekey-Content-IV": content.iv,
      "X-Pastekey-Wrapped-Key": wrapped.ciphertext,
      "X-Pastekey-Wrapped-Key-IV": wrapped.iv,
      "X-Pastekey-Metadata": metadata.encodedCiphertext,
      "X-Pastekey-Metadata-IV": metadata.iv,
    },
  };
});

export const decryptAttachmentMetadataEffect = Effect.fn("decryptAttachmentMetadata")(function*(
  pasteKey: CryptoKey,
  attachment: StoredAttachment,
) {
  const fileKey = yield* unwrapKeyEffect(
    { ciphertext: attachment.wrappedKey, iv: attachment.wrappedKeyIv },
    pasteKey,
    `pastekey/file/${attachment.id}/${attachment.pasteId}/v1`,
  );
  const ciphertext = yield* decodeBase64Url(attachment.metadataCiphertext);
  const plaintext = yield* decryptBytesEffect(
    fileKey,
    ciphertext,
    attachment.metadataIv,
    `pastekey/file-metadata/${attachment.id}/${attachment.pasteId}/v1`,
  );
  const value = yield* parseJson(plaintext);
  const metadata: AttachmentMetadata = yield* Schema.decodeUnknownEffect(AttachmentMetadataSchema)(value).pipe(
    Effect.map((decoded) => preserveDecodedProperties(decoded, value)),
    Effect.mapError((cause) => CryptoValidationError.make({
      message: "Invalid encrypted attachment metadata",
      cause,
    })),
  );
  return { fileKey, metadata };
});

export const decryptAttachmentContentEffect = Effect.fn("decryptAttachmentContent")(function*(
  fileKey: CryptoKey,
  attachment: StoredAttachment,
  ciphertext: ArrayBuffer,
) {
  return yield* decryptBytesEffect(
    fileKey,
    new Uint8Array(ciphertext),
    attachment.contentIv,
    `pastekey/file-content/${attachment.id}/${attachment.pasteId}/v1`,
  );
});
