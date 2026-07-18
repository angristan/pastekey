import { useCallback, useEffect, useState } from "react";

import type { StoredAttachment } from "../../../shared/protocol/attachments";
import { api } from "../../lib/api";
import type { UnlockedAttachment } from "../../lib/attachments";
import { decryptAttachmentMetadata } from "../../lib/crypto";
import { messageOf } from "../../lib/format";
import { settledValues } from "../../lib/settled";

export async function unlockAttachments(records: StoredAttachment[], pasteKey: CryptoKey) {
  return settledValues(
    records.map(async (stored) => ({ stored, ...(await decryptAttachmentMetadata(pasteKey, stored)) })),
  );
}

export function useUnlockedAttachments({
  pasteId,
  pasteKey,
  loadOnMount,
  onFailure,
}: {
  pasteId: string;
  pasteKey: CryptoKey;
  loadOnMount: boolean;
  onFailure: (message: string | null) => void;
}) {
  const [attachments, setAttachments] = useState<UnlockedAttachment[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    onFailure(null);
    try {
      const response = await api<{ attachments: StoredAttachment[] }>(`/api/pastes/${pasteId}/files`);
      const result = await unlockAttachments(response.attachments, pasteKey);
      setAttachments(result.values);
      if (result.failureCount) {
        onFailure(`${result.failureCount} encrypted ${result.failureCount === 1 ? "file could" : "files could"} not be decrypted.`);
      }
      return result.values;
    } finally {
      setLoading(false);
    }
  }, [onFailure, pasteId, pasteKey]);

  useEffect(() => {
    if (!loadOnMount) return;
    void load().catch((cause) => onFailure(messageOf(cause)));
  }, [load, loadOnMount, onFailure]);

  async function toggle() {
    if (attachments !== null) {
      setAttachments(null);
      return;
    }
    await load();
  }

  function remove(id: string) {
    setAttachments((current) => current?.filter((item) => item.stored.id !== id) ?? []);
  }

  return { attachments, load, loading, remove, setAttachments, toggle };
}
