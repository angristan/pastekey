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
