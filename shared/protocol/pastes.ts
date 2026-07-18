import type { StoredAttachment } from "./attachments";

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

export type ItemKind = "paste" | "files";

export type PastePayload = {
  title: string;
  content: string;
  language: string;
  kind?: ItemKind;
};

export type PasteWrite = {
  id: string;
  ciphertext: string;
  contentIv: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  expiresAt?: number | null;
};

export type ShareWrite = {
  id: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  expiresAt?: number | null;
};

export function itemKindOf(payload: PastePayload): ItemKind {
  return payload.kind === "files" ? "files" : "paste";
}
