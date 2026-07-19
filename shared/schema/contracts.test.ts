import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  AccountDeletionResponse,
  AttachmentListResponse,
  NoContentResponse,
  PasteCreateResponse,
  PasteListResponse,
  ShareCreateResponse,
  ShareListResponse,
} from "./api";
import { AttachmentMetadata, StoredAttachment } from "./attachments";
import {
  AuthSuccess,
  LoginVerifyRequest,
  MeResponse,
  RegistrationVerifyRequest,
  WrappedKey,
} from "./auth";
import { AppConfig } from "./config";
import { AccountDeletionPayload, DeletionMessage } from "./deletions";
import {
  PastePayload,
  PasteUpdate,
  PasteWrite,
  ShareWrite,
  StoredPaste,
  StoredShare,
} from "./pastes";
import { Base64Url, OpaqueId } from "./primitives";

const id = "abcdefghijklmnopqrst";
const secondId = "zyxwvutsrqponmlkjihg";
const encoded = "AA-_";

describe("wire scalar schemas", () => {
  it("accepts unpadded base64url and bounded opaque IDs", () => {
    expect(Schema.decodeUnknownSync(Base64Url)(encoded)).toBe(encoded);
    expect(Schema.decodeUnknownSync(OpaqueId)(id)).toBe(id);
    expect(() => Schema.decodeUnknownSync(Base64Url)("AA==")).toThrow();
    expect(() => Schema.decodeUnknownSync(Base64Url)("")).toThrow();
    expect(() => Schema.decodeUnknownSync(OpaqueId)("too-short")).toThrow();
    expect(() => Schema.decodeUnknownSync(OpaqueId)(`${id}!`)).toThrow();
  });
});

describe("authentication contracts", () => {
  it("round-trips wrapped keys and authentication success", () => {
    const wrapped = { ciphertext: encoded, iv: "AQID" };
    const success = {
      userId: id,
      credentialId: "credential-id",
      wrappedAccountKey: wrapped,
    };

    expect(Schema.encodeUnknownSync(WrappedKey)(Schema.decodeUnknownSync(WrappedKey)(wrapped))).toEqual(wrapped);
    expect(Schema.encodeUnknownSync(AuthSuccess)(Schema.decodeUnknownSync(AuthSuccess)(success))).toEqual(success);
  });

  it("preserves omitted MeResponse fields and rejects null", () => {
    const anonymous = { authenticated: false };
    const decoded = Schema.decodeUnknownSync(MeResponse)(anonymous);

    expect(Schema.encodeUnknownSync(MeResponse)(decoded)).toEqual(anonymous);
    expect("userId" in decoded).toBe(false);
    expect("passkeys" in decoded).toBe(false);
    expect(() => Schema.decodeUnknownSync(MeResponse)({ authenticated: false, userId: null })).toThrow();
  });

  it("accepts authenticated passkey summaries with nullable last use", () => {
    const response = {
      authenticated: true,
      userId: id,
      passkeys: [{
        id: "credential-id",
        createdAt: 100,
        lastUsedAt: null,
        backedUp: true,
        deviceType: "multiDevice",
      }],
    };

    expect(Schema.encodeUnknownSync(MeResponse)(Schema.decodeUnknownSync(MeResponse)(response))).toEqual(response);
  });

  it("decodes structurally compatible WebAuthn verification requests", () => {
    const registration = Schema.decodeUnknownSync(RegistrationVerifyRequest)({
      credential: {
        id: "credential-id",
        rawId: "credential-id",
        response: {
          clientDataJSON: encoded,
          attestationObject: encoded,
          transports: ["internal", "hybrid"],
        },
        authenticatorAttachment: "platform",
        clientExtensionResults: { credProps: { rk: true } },
        type: "public-key",
      },
      wrappedAccountKey: { ciphertext: encoded, iv: encoded },
    });
    const login = Schema.decodeUnknownSync(LoginVerifyRequest)({
      credential: {
        id: "credential-id",
        rawId: "credential-id",
        response: {
          clientDataJSON: encoded,
          authenticatorData: encoded,
          signature: encoded,
        },
        clientExtensionResults: {},
        type: "public-key",
      },
    });

    const registrationCredential: RegistrationResponseJSON = registration.credential;
    const authenticationCredential: AuthenticationResponseJSON = login.credential;
    expect(registrationCredential.response.transports).toEqual(["internal", "hybrid"]);
    expect(authenticationCredential.id).toBe("credential-id");
    expect(() => Schema.decodeUnknownSync(LoginVerifyRequest)({
      credential: { ...login.credential, type: "password" },
    })).toThrow();
    expect(() => Schema.decodeUnknownSync(RegistrationVerifyRequest)({
      credential: {
        ...registration.credential,
        response: { ...registration.credential.response, transports: ["carrier-pigeon"] },
      },
      wrappedAccountKey: registration.wrappedAccountKey,
    })).toThrow();
  });
});

describe("configuration contract", () => {
  it("requires every limit and preserves registration and site-key state", () => {
    const config = {
      limits: {
        maxFileBytes: 1,
        maxFilesPerPaste: 2,
        maxPastesPerUser: 3,
        maxStorageBytes: 4,
      },
      registrationEnabled: true,
      turnstileSiteKey: null,
    };

    expect(Schema.encodeUnknownSync(AppConfig)(Schema.decodeUnknownSync(AppConfig)(config))).toEqual(config);
    expect(() => Schema.decodeUnknownSync(AppConfig)({ limits: config.limits })).toThrow();
  });
});

describe("paste and share contracts", () => {
  it("preserves a legacy payload with no kind", () => {
    const legacy = { title: "Legacy", content: "text", language: "plaintext" };
    const decoded = Schema.decodeUnknownSync(PastePayload)(legacy);

    expect(Schema.encodeUnknownSync(PastePayload)(decoded)).toEqual(legacy);
    expect("kind" in decoded).toBe(false);
    expect(() => Schema.decodeUnknownSync(PastePayload)({ ...legacy, kind: null })).toThrow();
    expect(Schema.decodeUnknownSync(PastePayload)({ ...legacy, kind: "files" }).kind).toBe("files");
  });

  it("distinguishes omitted and null write expiry", () => {
    const paste = {
      id,
      ciphertext: encoded,
      contentIv: encoded,
      wrappedKey: encoded,
      wrappedKeyIv: encoded,
    };
    const share = { id: secondId, wrappedKey: encoded, wrappedKeyIv: encoded };

    expect(Schema.encodeUnknownSync(PasteWrite)(Schema.decodeUnknownSync(PasteWrite)(paste))).toEqual(paste);
    expect(Schema.encodeUnknownSync(PasteWrite)(Schema.decodeUnknownSync(PasteWrite)({ ...paste, expiresAt: null })))
      .toEqual({ ...paste, expiresAt: null });
    expect(Schema.encodeUnknownSync(ShareWrite)(Schema.decodeUnknownSync(ShareWrite)(share))).toEqual(share);
    expect(Schema.decodeUnknownSync(PasteUpdate)({ ...paste, id: undefined }).ciphertext).toBe(encoded);
    expect(() => Schema.decodeUnknownSync(PasteWrite)({ ...paste, expiresAt: undefined })).toThrow();
    expect(() => Schema.decodeUnknownSync(PasteWrite)({ ...paste, ciphertext: "A".repeat(1_000_001) })).toThrow();
    expect(() => Schema.decodeUnknownSync(PasteUpdate)({ ...paste, id: undefined, wrappedKey: "A".repeat(10_001) }))
      .toThrow();
  });

  it("round-trips stored paste and share shapes", () => {
    const attachment = {
      id: secondId,
      pasteId: id,
      ciphertextSize: 16,
      contentIv: encoded,
      wrappedKey: encoded,
      wrappedKeyIv: encoded,
      metadataCiphertext: encoded,
      metadataIv: encoded,
      createdAt: 100,
    };
    const paste = {
      id,
      ciphertext: encoded,
      contentIv: encoded,
      wrappedKey: encoded,
      wrappedKeyIv: encoded,
      createdAt: 100,
      updatedAt: 200,
      expiresAt: null,
      version: 1,
    };
    const share = {
      id: secondId,
      pasteId: id,
      ciphertext: encoded,
      contentIv: encoded,
      wrappedKey: encoded,
      wrappedKeyIv: encoded,
      createdAt: 100,
      updatedAt: 200,
      expiresAt: null,
      attachments: [attachment],
    };

    expect(Schema.encodeUnknownSync(StoredPaste)(Schema.decodeUnknownSync(StoredPaste)(paste))).toEqual(paste);
    expect(Schema.encodeUnknownSync(StoredShare)(Schema.decodeUnknownSync(StoredShare)(share))).toEqual(share);
    expect(() => Schema.decodeUnknownSync(StoredPaste)({ ...paste, expiresAt: undefined })).toThrow();
  });
});

describe("attachment contracts", () => {
  it("round-trips attachment metadata and storage records", () => {
    const metadata = { name: "archive.bin", type: "application/octet-stream", size: 42 };
    const attachment = {
      id: secondId,
      pasteId: id,
      ciphertextSize: 58,
      contentIv: encoded,
      wrappedKey: encoded,
      wrappedKeyIv: encoded,
      metadataCiphertext: encoded,
      metadataIv: encoded,
      createdAt: 100,
    };

    expect(Schema.encodeUnknownSync(AttachmentMetadata)(Schema.decodeUnknownSync(AttachmentMetadata)(metadata)))
      .toEqual(metadata);
    expect(Schema.encodeUnknownSync(StoredAttachment)(Schema.decodeUnknownSync(StoredAttachment)(attachment)))
      .toEqual(attachment);
  });
});

describe("API response contracts", () => {
  it("decodes list and creation wrappers", () => {
    const attachment = {
      id: secondId,
      pasteId: id,
      ciphertextSize: 16,
      contentIv: encoded,
      wrappedKey: encoded,
      wrappedKeyIv: encoded,
      metadataCiphertext: encoded,
      metadataIv: encoded,
      createdAt: 100,
    };
    const paste = {
      id,
      ciphertext: encoded,
      contentIv: encoded,
      wrappedKey: encoded,
      wrappedKeyIv: encoded,
      createdAt: 100,
      updatedAt: 200,
      expiresAt: null,
      version: 1,
    };

    expect(Schema.decodeUnknownSync(AttachmentListResponse)({ attachments: [attachment] }).attachments).toHaveLength(1);
    expect(Schema.decodeUnknownSync(PasteListResponse)({ pastes: [paste] }).pastes).toHaveLength(1);
    expect(Schema.decodeUnknownSync(PasteCreateResponse)({ id, createdAt: 100 }).id).toBe(id);
    expect(Schema.decodeUnknownSync(ShareCreateResponse)({ id: secondId, createdAt: 100 }).id).toBe(secondId);
    expect(Schema.decodeUnknownSync(ShareListResponse)({
      shares: [{ id: secondId, createdAt: 100, expiresAt: null }],
    }).shares).toHaveLength(1);
  });

  it("requires exact status and no-content shapes", () => {
    expect(Schema.decodeUnknownSync(AccountDeletionResponse)({ status: "deleting" }).status).toBe("deleting");
    expect(() => Schema.decodeUnknownSync(AccountDeletionResponse)({ status: "deleted" })).toThrow();
    expect(Schema.decodeUnknownSync(NoContentResponse)(undefined)).toBeUndefined();
    expect(() => Schema.decodeUnknownSync(NoContentResponse)(null)).toThrow();
  });
});

describe("durable operation contracts", () => {
  it("preserves missing queue cycle and rejects null", () => {
    const message = { jobId: id };
    const decoded = Schema.decodeUnknownSync(DeletionMessage)(message);

    expect(Schema.encodeUnknownSync(DeletionMessage)(decoded)).toEqual(message);
    expect("cycle" in decoded).toBe(false);
    expect(Schema.decodeUnknownSync(DeletionMessage)({ jobId: id, cycle: 0 }).cycle).toBe(0);
    expect(() => Schema.decodeUnknownSync(DeletionMessage)({ jobId: id, cycle: null })).toThrow();
  });

  it("round-trips account workflow payloads", () => {
    const payload = { userId: id };
    expect(Schema.encodeUnknownSync(AccountDeletionPayload)(Schema.decodeUnknownSync(AccountDeletionPayload)(payload)))
      .toEqual(payload);
  });
});
