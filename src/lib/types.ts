export type WrappedKey = {
  ciphertext: string;
  iv: string;
};

export type StoredPaste = {
  id: string;
  ciphertext: string;
  contentIv: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  version: number;
};

export type StoredAttachment = {
  id: string;
  pasteId: string;
  ciphertextSize: number;
  contentIv: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  metadataCiphertext: string;
  metadataIv: string;
  createdAt: number;
};

export type AttachmentMetadata = {
  name: string;
  type: string;
  size: number;
};

export type StoredShare = {
  id: string;
  pasteId: string;
  ciphertext: string;
  contentIv: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  attachments: StoredAttachment[];
};

export type PastePayload = {
  title: string;
  content: string;
  language: string;
};

export type PasskeySummary = {
  id: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
  deviceType: string;
};

export type MeResponse = {
  authenticated: boolean;
  userId?: string;
  passkeys?: PasskeySummary[];
};

export type AppConfig = {
  limits: {
    maxFileBytes: number;
    maxFilesPerPaste: number;
    maxPastesPerUser: number;
    maxStorageBytes: number;
  };
  turnstileSiteKey: string | null;
};

export type AuthSuccess = {
  userId: string;
  credentialId: string;
  wrappedAccountKey: WrappedKey;
};
