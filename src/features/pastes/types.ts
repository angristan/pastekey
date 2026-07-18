import type { PastePayload, StoredPaste } from "../../../shared/protocol/pastes";
import type { UnlockedAttachment } from "../../lib/attachments";

export type UnlockedPaste = {
  stored: StoredPaste;
  payload: PastePayload;
  pasteKey: CryptoKey;
  attachments: UnlockedAttachment[];
  attachmentFailureCount: number;
};
