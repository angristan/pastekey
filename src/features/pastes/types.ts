import type { PastePayload, StoredPaste } from "../../lib/types";

export type UnlockedPaste = {
  stored: StoredPaste;
  payload: PastePayload;
  pasteKey: CryptoKey;
};
