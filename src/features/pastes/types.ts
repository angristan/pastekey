import type { PastePayload, StoredPaste } from "../../../shared/protocol/pastes";

export type UnlockedPaste = {
  stored: StoredPaste;
  payload: PastePayload;
  pasteKey: CryptoKey;
};
