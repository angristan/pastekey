import type {
  AttachmentMetadata,
  PastePayload,
  StoredAttachment,
  StoredPaste,
  StoredShare,
  WrappedKey,
} from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AES_GCM = { name: "AES-GCM", length: 256 } as const;
const PASTE_KEY_USAGES: KeyUsage[] = ["encrypt", "decrypt", "wrapKey", "unwrapKey"];

export const PRF_INPUT = encoder.encode("pastekey/passkey-prf/v1");

export function randomId(bytes = 16) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function generateAccountKey() {
  return crypto.subtle.generateKey(AES_GCM, true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
}

export async function derivePasskeyWrappingKey(prfOutput: unknown) {
  const material = normalizePrfOutput(prfOutput);
  const inputKey = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("pastekey/passkey-kek/salt/v1"),
      info: encoder.encode("pastekey/account-key/wrapping/v1"),
    },
    inputKey,
    AES_GCM,
    false,
    ["wrapKey", "unwrapKey"],
  );
}

export async function wrapAccountKey(accountKey: CryptoKey, passkeyKey: CryptoKey, credentialId: string) {
  return wrapKey(accountKey, passkeyKey, `pastekey/account/${credentialId}/v1`);
}

export async function unwrapAccountKey(envelope: WrappedKey, passkeyKey: CryptoKey, credentialId: string) {
  return unwrapKey(envelope, passkeyKey, `pastekey/account/${credentialId}/v1`, [
    "encrypt",
    "decrypt",
    "wrapKey",
    "unwrapKey",
  ]);
}

export async function encryptNewPaste(
  accountKey: CryptoKey,
  payload: PastePayload,
  expiresAt: number | null,
) {
  const id = randomId();
  const pasteKey = await crypto.subtle.generateKey(AES_GCM, true, PASTE_KEY_USAGES);
  const encrypted = await encryptPayload(pasteKey, id, payload);
  const wrapped = await wrapKey(pasteKey, accountKey, `pastekey/owner/${id}/v1`);

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
}

export async function encryptExistingPaste(
  accountKey: CryptoKey,
  pasteKey: CryptoKey,
  id: string,
  payload: PastePayload,
  expiresAt: number | null,
) {
  const encrypted = await encryptPayload(pasteKey, id, payload);
  const wrapped = await wrapKey(pasteKey, accountKey, `pastekey/owner/${id}/v1`);
  return {
    ciphertext: encrypted.ciphertext,
    contentIv: encrypted.iv,
    wrappedKey: wrapped.ciphertext,
    wrappedKeyIv: wrapped.iv,
    expiresAt,
  };
}

export async function decryptOwnedPaste(accountKey: CryptoKey, stored: StoredPaste) {
  const pasteKey = await unwrapKey(
    { ciphertext: stored.wrappedKey, iv: stored.wrappedKeyIv },
    accountKey,
    `pastekey/owner/${stored.id}/v1`,
    PASTE_KEY_USAGES,
  );
  const payload = await decryptPayload(pasteKey, stored.id, stored.ciphertext, stored.contentIv);
  return { pasteKey, payload };
}

export async function createShareEnvelope(pasteId: string, pasteKey: CryptoKey, expiresAt: number | null) {
  const id = randomId();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const shareKey = await deriveShareKey(secret, id, pasteId);
  const wrapped = await wrapKey(pasteKey, shareKey, `pastekey/share/${id}/${pasteId}/v1`);

  return {
    secret: toBase64Url(secret),
    write: {
      id,
      wrappedKey: wrapped.ciphertext,
      wrappedKeyIv: wrapped.iv,
      expiresAt,
    },
  };
}

export async function decryptSharedPaste(stored: StoredShare, encodedSecret: string) {
  const secret = fromBase64Url(encodedSecret);
  if (secret.byteLength !== 32) throw new Error("Invalid share secret");

  const shareKey = await deriveShareKey(secret, stored.id, stored.pasteId);
  const pasteKey = await unwrapKey(
    { ciphertext: stored.wrappedKey, iv: stored.wrappedKeyIv },
    shareKey,
    `pastekey/share/${stored.id}/${stored.pasteId}/v1`,
    PASTE_KEY_USAGES,
  );
  const payload = await decryptPayload(pasteKey, stored.pasteId, stored.ciphertext, stored.contentIv);
  return { pasteKey, payload };
}

export async function encryptAttachment(pasteKey: CryptoKey, pasteId: string, file: File) {
  const id = randomId();
  const fileKey = await crypto.subtle.generateKey(AES_GCM, true, ["encrypt", "decrypt"]);
  const wrapped = await wrapKey(fileKey, pasteKey, `pastekey/file/${id}/${pasteId}/v1`);
  const metadata = await encryptBytes(
    fileKey,
    encoder.encode(JSON.stringify({ name: file.name, type: file.type || "application/octet-stream", size: file.size })),
    `pastekey/file-metadata/${id}/${pasteId}/v1`,
  );
  const content = await encryptBytes(
    fileKey,
    new Uint8Array(await file.arrayBuffer()),
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
}

export async function decryptAttachmentMetadata(pasteKey: CryptoKey, attachment: StoredAttachment) {
  const fileKey = await unwrapKey(
    { ciphertext: attachment.wrappedKey, iv: attachment.wrappedKeyIv },
    pasteKey,
    `pastekey/file/${attachment.id}/${attachment.pasteId}/v1`,
  );
  const plaintext = await decryptBytes(
    fileKey,
    fromBase64Url(attachment.metadataCiphertext),
    attachment.metadataIv,
    `pastekey/file-metadata/${attachment.id}/${attachment.pasteId}/v1`,
  );
  const metadata = JSON.parse(decoder.decode(plaintext)) as Partial<AttachmentMetadata>;
  if (
    typeof metadata.name !== "string" ||
    typeof metadata.type !== "string" ||
    typeof metadata.size !== "number" ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0
  ) {
    throw new Error("Invalid encrypted attachment metadata");
  }
  return { fileKey, metadata: metadata as AttachmentMetadata };
}

export async function decryptAttachmentContent(
  fileKey: CryptoKey,
  attachment: StoredAttachment,
  ciphertext: ArrayBuffer,
) {
  return decryptBytes(
    fileKey,
    new Uint8Array(ciphertext),
    attachment.contentIv,
    `pastekey/file-content/${attachment.id}/${attachment.pasteId}/v1`,
  );
}

async function deriveShareKey(secret: Uint8Array<ArrayBuffer>, shareId: string, pasteId: string) {
  const inputKey = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(`pastekey/share/${shareId}/salt/v1`),
      info: encoder.encode(`pastekey/share/${pasteId}/wrapping/v1`),
    },
    inputKey,
    AES_GCM,
    false,
    ["wrapKey", "unwrapKey"],
  );
}

async function encryptBytes(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>, additionalData: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(additionalData) },
      key,
      plaintext,
    ),
  );
  return {
    ciphertext,
    encodedCiphertext: toBase64Url(ciphertext),
    iv: toBase64Url(iv),
  };
}

async function decryptBytes(
  key: CryptoKey,
  ciphertext: Uint8Array<ArrayBuffer>,
  encodedIv: string,
  additionalData: string,
) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(encodedIv),
        additionalData: encoder.encode(additionalData),
      },
      key,
      ciphertext,
    ),
  );
}

async function encryptPayload(key: CryptoKey, id: string, payload: PastePayload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(`pastekey/paste/${id}/v1`) },
    key,
    plaintext,
  );
  return { ciphertext: toBase64Url(new Uint8Array(ciphertext)), iv: toBase64Url(iv) };
}

async function decryptPayload(key: CryptoKey, id: string, ciphertext: string, encodedIv: string) {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(encodedIv),
      additionalData: encoder.encode(`pastekey/paste/${id}/v1`),
    },
    key,
    fromBase64Url(ciphertext),
  );
  const value = JSON.parse(decoder.decode(plaintext)) as Partial<PastePayload>;
  if (typeof value.title !== "string" || typeof value.content !== "string" || typeof value.language !== "string") {
    throw new Error("Invalid encrypted paste payload");
  }
  return value as PastePayload;
}

async function wrapKey(key: CryptoKey, wrappingKey: CryptoKey, additionalData: string): Promise<WrappedKey> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.wrapKey(
    "raw",
    key,
    wrappingKey,
    { name: "AES-GCM", iv, additionalData: encoder.encode(additionalData) },
  );
  return { ciphertext: toBase64Url(new Uint8Array(ciphertext)), iv: toBase64Url(iv) };
}

async function unwrapKey(
  envelope: WrappedKey,
  wrappingKey: CryptoKey,
  additionalData: string,
  usages: KeyUsage[] = ["encrypt", "decrypt"],
) {
  return crypto.subtle.unwrapKey(
    "raw",
    fromBase64Url(envelope.ciphertext),
    wrappingKey,
    { name: "AES-GCM", iv: fromBase64Url(envelope.iv), additionalData: encoder.encode(additionalData) },
    AES_GCM,
    true,
    usages,
  );
}

export function normalizePrfOutput(value: unknown): Uint8Array<ArrayBuffer> {
  let source: Uint8Array<ArrayBufferLike>;

  if (value instanceof ArrayBuffer) {
    source = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (typeof value === "string") {
    source = fromBase64Url(value);
  } else if (Array.isArray(value)) {
    if (!value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      throw new Error("WebAuthn PRF returned an invalid byte array");
    }
    source = Uint8Array.from(value as number[]);
  } else {
    throw new Error(`WebAuthn PRF returned unsupported key data (${Object.prototype.toString.call(value)})`);
  }

  if (source.byteLength !== 32) {
    throw new Error(`WebAuthn PRF returned ${source.byteLength} bytes; expected 32`);
  }

  // Some authenticators return views backed by non-standard or cross-realm buffers.
  // Copy into a fresh ArrayBuffer so WebCrypto always receives a valid BufferSource.
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

export function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
