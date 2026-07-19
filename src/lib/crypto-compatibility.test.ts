import { describe, expect, it } from "vitest";

import type { StoredAttachment } from "../../shared/protocol/attachments";
import type { PastePayload, StoredPaste, StoredShare } from "../../shared/protocol/pastes";
import {
  decryptAttachmentContent,
  decryptAttachmentMetadata,
  decryptOwnedPaste,
  decryptSharedPaste,
  derivePasskeyWrappingKey,
  fromBase64Url,
  toBase64Url,
  unwrapAccountKey,
} from "./crypto";

// Generated independently with WebCrypto from fixed raw keys, IVs, and secrets.
// Keep these values literal: they represent the persisted v1 format, not fresh output
// from the implementation under test.
const fixture = {
  credentialId: "legacy-credential-AQID_v1",
  prfOutput: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  accountKey: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
  pasteKey: "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
  fileKey: "gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8",
  shareSecret: "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8",
  wrappedAccountKey: {
    ciphertext: "CC08C5UHe-ftoqJJTzdUVSeCPy7O47a4oNWIoRKniZq194UmaAFQHHRs8WG4DUMT",
    iv: "oKGio6Slpqeoqaqr",
  },
  attachmentCiphertext: "AA_Kj7lndI3waNbG27eH92Zs_ZUq4pBHhoBqW4p9",
};

const legacyPayload: PastePayload = {
  title: "Legacy 🔐 fixture",
  content: "first line\nsecond line",
  language: "text",
};

const storedPaste: StoredPaste = {
  id: "legacy-paste-fixture-v1",
  ciphertext:
    "JGZEpw72WMlOm2hTzMLBtL8FwcVODkhhhMdGHk1YVmTnWT3zlMhintASFHs5TjATAe0mUF0SUi3U3BEVyWSIP2qO83f8NRhH1WiDG7YZ4FC75-WN4pvLLzhL76H4X8QhVUZw6Co",
  contentIv: "wMHCw8TFxsfIycrL",
  wrappedKey: "drtoBNZmjkl6RFexT3DTecZi8MjeHcJmuB31A4l6U4CT6FEsGKzpHUtQBfNzT5SP",
  wrappedKeyIv: "sLGys7S1tre4ubq7",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  expiresAt: null,
  version: 1,
};

const storedAttachment: StoredAttachment = {
  id: "legacy-attachment-fixture-v1",
  pasteId: storedPaste.id,
  ciphertextSize: 30,
  contentIv: "AQIDBAUGBwgJCgsM",
  wrappedKey: "L1lL6l6KMlcdSnxsRjKZ5xuncgxSoCxoDocyt_wCdPPRf26Yx9pi0AABxMeQmqZO",
  wrappedKeyIv: "4OHi4-Tl5ufo6err",
  metadataCiphertext:
    "hhzqRQmiGArcZU1Vby3ybRj5u78lxud0-2u4ByFwVvTdv_vJFzBw7P9e9zk_vRWVBNDQzslPvLhN-J1fkkz67E7MxtYBLWxyB3TT_u_fmHUM_p71s5sZSiKN",
  metadataIv: "8PHy8_T19vf4-fr7",
  createdAt: 1_700_000_000_000,
};

const storedShare: StoredShare = {
  id: "legacy-share-fixture-v1",
  pasteId: storedPaste.id,
  ciphertext: storedPaste.ciphertext,
  contentIv: storedPaste.contentIv,
  wrappedKey: "ABVpPldL8baAEassuPzOJ6-OMZRTaTlfolG1m3hba_oMMJqf_cTQ0z0htxMZoHdJ",
  wrappedKeyIv: "0NHS09TV1tfY2drb",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  expiresAt: null,
  attachments: [storedAttachment],
};

describe("legacy crypto compatibility fixtures", () => {
  it("keeps unpadded base64url encoding stable", () => {
    expect(toBase64Url(Uint8Array.of(251, 255, 239, 254))).toBe("-__v_g");
    expect(Array.from(fromBase64Url("-__v_g"))).toEqual([251, 255, 239, 254]);
    expect(() => fromBase64Url("AA==")).toThrow("Invalid base64url value");
  });

  it("derives the passkey HKDF key and unwraps the persisted account key", async () => {
    const passkeyKey = await derivePasskeyWrappingKey(fixture.prfOutput);
    const accountKey = await unwrapAccountKey(fixture.wrappedAccountKey, passkeyKey, fixture.credentialId);

    await expect(exportBase64Url(accountKey)).resolves.toBe(fixture.accountKey);
    await expect(unwrapAccountKey(fixture.wrappedAccountKey, passkeyKey, `${fixture.credentialId}-wrong`)).rejects.toThrow();
  });

  it("decrypts an owned v1 paste whose payload predates kind", async () => {
    const accountKey = await importAesKey(fixture.accountKey);
    const unlocked = await decryptOwnedPaste(accountKey, storedPaste);

    expect(unlocked.payload).toEqual(legacyPayload);
    expect("kind" in unlocked.payload).toBe(false);
    await expect(exportBase64Url(unlocked.pasteKey)).resolves.toBe(fixture.pasteKey);
    await expect(decryptOwnedPaste(accountKey, { ...storedPaste, id: `${storedPaste.id}-wrong` })).rejects.toThrow();
  });

  it("derives the share HKDF key and decrypts the shared v1 paste", async () => {
    const unlocked = await decryptSharedPaste(storedShare, fixture.shareSecret);

    expect(unlocked.payload).toEqual(legacyPayload);
    await expect(exportBase64Url(unlocked.pasteKey)).resolves.toBe(fixture.pasteKey);
    await expect(decryptSharedPaste({ ...storedShare, id: `${storedShare.id}-wrong` }, fixture.shareSecret)).rejects.toThrow();
  });

  it("decrypts persisted attachment metadata and content with their AAD", async () => {
    const pasteKey = await importAesKey(fixture.pasteKey);
    const unlocked = await decryptAttachmentMetadata(pasteKey, storedAttachment);

    expect(unlocked.metadata).toEqual({
      name: "legacy résumé.txt",
      type: "application/octet-stream",
      size: 14,
    });
    await expect(exportBase64Url(unlocked.fileKey)).resolves.toBe(fixture.fileKey);

    const ciphertext = fromBase64Url(fixture.attachmentCiphertext).buffer;
    const plaintext = await decryptAttachmentContent(unlocked.fileKey, storedAttachment, ciphertext);
    expect(Array.from(plaintext)).toEqual([0, 1, 2, 127, 128, 254, 255, 10, 76, 101, 103, 97, 99, 121]);

    const wrongIdentity = { ...storedAttachment, pasteId: `${storedAttachment.pasteId}-wrong` };
    await expect(decryptAttachmentMetadata(pasteKey, wrongIdentity)).rejects.toThrow();
    await expect(decryptAttachmentContent(unlocked.fileKey, wrongIdentity, ciphertext)).rejects.toThrow();
  });
});

async function importAesKey(encoded: string) {
  return crypto.subtle.importKey(
    "raw",
    fromBase64Url(encoded),
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
  );
}

async function exportBase64Url(key: CryptoKey) {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}
