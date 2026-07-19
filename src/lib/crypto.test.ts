import { describe, expect, it, vi } from "vitest";

import {
  createShareEnvelope,
  decryptAttachmentContent,
  decryptAttachmentMetadata,
  decryptOwnedPaste,
  decryptSharedPaste,
  derivePasskeyWrappingKey,
  encryptAttachment,
  encryptNewPaste,
  generateAccountKey,
  normalizePrfOutput,
  randomId,
  toBase64Url,
  unwrapAccountKey,
  wrapAccountKey,
} from "./crypto";
import type { StoredAttachment } from "../../shared/protocol/attachments";
import { itemKindOf, type PastePayload, type StoredPaste, type StoredShare } from "../../shared/protocol/pastes";

const payload: PastePayload = {
  title: "Production notes",
  content: "deploy --region=earth\nstatus --json",
  language: "shell",
};

describe("Pastekey envelope encryption", () => {
  it("normalizes authenticator PRF results into WebCrypto key data", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(normalizePrfOutput(bytes)).toEqual(bytes);
    expect(normalizePrfOutput(view)).toEqual(bytes);
    expect(normalizePrfOutput(toBase64Url(bytes))).toEqual(bytes);
    expect(normalizePrfOutput(Array.from(bytes))).toEqual(bytes);
    expect(() => normalizePrfOutput(new Uint8Array(31))).toThrow("expected 32");
    expect(() => normalizePrfOutput([...Array.from(bytes).slice(0, 31), 256])).toThrow("invalid byte array");
  });

  it("wraps the account key independently for a passkey", async () => {
    const accountKey = await generateAccountKey();
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const passkeyKey = await derivePasskeyWrappingKey(prf.buffer);
    const credentialId = randomId();

    const wrapped = await wrapAccountKey(accountKey, passkeyKey, credentialId);
    const recovered = await unwrapAccountKey(wrapped, passkeyKey, credentialId);
    expect(recovered.extractable).toBe(true);
    expect([...recovered.usages]).toEqual(["encrypt", "decrypt", "wrapKey", "unwrapKey"]);

    const encrypted = await encryptNewPaste(recovered, payload, null);
    const stored = asStoredPaste(encrypted.write);
    await expect(decryptOwnedPaste(accountKey, stored)).resolves.toMatchObject({ payload });
  });

  it("decrypts a paste through only its share secret", async () => {
    const accountKey = await generateAccountKey();
    const encrypted = await encryptNewPaste(accountKey, payload, null);
    const stored = asStoredPaste(encrypted.write);
    const owned = await decryptOwnedPaste(accountKey, stored);
    const share = await createShareEnvelope(stored.id, owned.pasteKey, null);
    const shared: StoredShare = {
      id: share.write.id,
      pasteId: stored.id,
      ciphertext: stored.ciphertext,
      contentIv: stored.contentIv,
      wrappedKey: share.write.wrappedKey,
      wrappedKeyIv: share.write.wrappedKeyIv,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: null,
      attachments: [],
    };

    await expect(decryptSharedPaste(shared, share.secret)).resolves.toMatchObject({ payload });
    await expect(decryptSharedPaste(shared, randomId(32))).rejects.toThrow();
  });

  it("distinguishes encrypted file items while keeping legacy pastes compatible", async () => {
    const accountKey = await generateAccountKey();
    const legacyEncrypted = await encryptNewPaste(accountKey, payload, null);
    const legacy = await decryptOwnedPaste(accountKey, asStoredPaste(legacyEncrypted.write));
    expect(itemKindOf(legacy.payload)).toBe("paste");

    const filesPayload: PastePayload = {
      kind: "files",
      title: "Design assets",
      content: "",
      language: "files",
    };
    const encrypted = await encryptNewPaste(accountKey, filesPayload, null);
    const unlocked = await decryptOwnedPaste(accountKey, asStoredPaste(encrypted.write));
    expect(itemKindOf(unlocked.payload)).toBe("files");
    expect(unlocked.payload).toEqual(filesPayload);

    const invalid = await encryptNewPaste(accountKey, { ...payload, kind: "unknown" } as unknown as PastePayload, null);
    await expect(decryptOwnedPaste(accountKey, asStoredPaste(invalid.write))).rejects.toThrow("Invalid encrypted paste payload");
  });

  it("preserves extension fields in encrypted legacy payloads", async () => {
    const accountKey = await generateAccountKey();
    const extendedPayload: PastePayload & { futureField: string } = {
      ...payload,
      futureField: "preserve-me",
    };
    const encrypted = await encryptNewPaste(accountKey, extendedPayload, null);

    await expect(decryptOwnedPaste(accountKey, asStoredPaste(encrypted.write))).resolves.toMatchObject({
      payload: extendedPayload,
    });
  });

  it("encrypts file bytes and metadata under a paste key", async () => {
    const accountKey = await generateAccountKey();
    const encrypted = await encryptNewPaste(accountKey, payload, null);
    const file = new File(["private attachment"], "secret.txt", { type: "text/plain" });
    const prepared = await encryptAttachment(encrypted.pasteKey, encrypted.write.id, file);
    const stored: StoredAttachment = {
      id: prepared.id,
      pasteId: encrypted.write.id,
      ciphertextSize: prepared.body.byteLength,
      contentIv: prepared.headers["X-Pastekey-Content-IV"],
      wrappedKey: prepared.headers["X-Pastekey-Wrapped-Key"],
      wrappedKeyIv: prepared.headers["X-Pastekey-Wrapped-Key-IV"],
      metadataCiphertext: prepared.headers["X-Pastekey-Metadata"],
      metadataIv: prepared.headers["X-Pastekey-Metadata-IV"],
      createdAt: Date.now(),
    };

    const unlocked = await decryptAttachmentMetadata(encrypted.pasteKey, stored);
    expect(unlocked.fileKey.extractable).toBe(true);
    expect([...unlocked.fileKey.usages]).toEqual(["encrypt", "decrypt"]);
    expect(unlocked.metadata).toEqual({ name: "secret.txt", type: "text/plain", size: 18 });
    const plaintext = await decryptAttachmentContent(unlocked.fileKey, stored, prepared.body.buffer);
    expect(new TextDecoder().decode(plaintext)).toBe("private attachment");
  });

  it("does not Base64-encode binary attachment content", async () => {
    const originalBtoa = globalThis.btoa;
    const encodedLengths: number[] = [];
    const btoa = vi.spyOn(globalThis, "btoa").mockImplementation((value) => {
      encodedLengths.push(value.length);
      return originalBtoa(value);
    });

    try {
      const accountKey = await generateAccountKey();
      const encrypted = await encryptNewPaste(accountKey, payload, null);
      const file = new File([new Uint8Array(64 * 1024)], "binary.dat", {
        type: "application/octet-stream",
      });
      const prepared = await encryptAttachment(encrypted.pasteKey, encrypted.write.id, file);

      expect(prepared.body.byteLength).toBe(file.size + 16);
      expect(Math.max(...encodedLengths)).toBeLessThan(4 * 1024);
    } finally {
      btoa.mockRestore();
    }
  });

  it("does not open one paste with another paste envelope", async () => {
    const accountKey = await generateAccountKey();
    const first = await encryptNewPaste(accountKey, payload, null);
    const second = await encryptNewPaste(accountKey, { ...payload, title: "Other" }, null);
    const mixed: StoredPaste = {
      ...asStoredPaste(first.write),
      wrappedKey: second.write.wrappedKey,
      wrappedKeyIv: second.write.wrappedKeyIv,
    };

    await expect(decryptOwnedPaste(accountKey, mixed)).rejects.toThrow();
  });
});

function asStoredPaste(write: Awaited<ReturnType<typeof encryptNewPaste>>["write"]): StoredPaste {
  const now = Date.now();
  return {
    ...write,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}
