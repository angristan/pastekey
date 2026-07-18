import { useCallback, useEffect, useRef, useState } from "react";

import type { StoredAttachment } from "../../../shared/protocol/attachments";
import { api } from "../../lib/api";
import type { UnlockedAttachment } from "../../lib/attachments";
import { settledMap } from "../../lib/concurrency";
import { decryptAttachmentMetadata } from "../../lib/crypto";
import { messageOf } from "../../lib/format";

export async function unlockAttachments(records: StoredAttachment[], pasteKey: CryptoKey) {
  return settledMap(records, 4, async (stored) => ({
    stored,
    ...(await decryptAttachmentMetadata(pasteKey, stored)),
  }));
}

export function useUnlockedAttachments({
  pasteId,
  pasteKey,
  loadOnMount,
  initialAttachments,
  initialFailureCount = 0,
  onFailure,
}: {
  pasteId: string;
  pasteKey: CryptoKey;
  loadOnMount: boolean;
  initialAttachments?: UnlockedAttachment[];
  initialFailureCount?: number;
  onFailure: (message: string | null) => void;
}) {
  const cached = useRef<UnlockedAttachment[] | undefined>(initialAttachments);
  const cachedFailureCount = useRef(initialFailureCount);
  const [attachments, setAttachments] = useState<UnlockedAttachment[] | null>(
    loadOnMount && initialAttachments ? initialAttachments : null,
  );
  const [loading, setLoading] = useState(false);

  const reportFailures = useCallback((failureCount: number) => {
    if (failureCount) {
      onFailure(`${failureCount} encrypted ${failureCount === 1 ? "file could" : "files could"} not be decrypted.`);
    } else {
      onFailure(null);
    }
  }, [onFailure]);

  const load = useCallback(async () => {
    if (cached.current) {
      setAttachments(cached.current);
      reportFailures(cachedFailureCount.current);
      return cached.current;
    }

    setLoading(true);
    onFailure(null);
    try {
      const response = await api<{ attachments: StoredAttachment[] }>(`/api/pastes/${pasteId}/files`);
      const result = await unlockAttachments(response.attachments, pasteKey);
      cached.current = result.values;
      cachedFailureCount.current = result.failureCount;
      setAttachments(result.values);
      reportFailures(result.failureCount);
      return result.values;
    } finally {
      setLoading(false);
    }
  }, [onFailure, pasteId, pasteKey, reportFailures]);

  useEffect(() => {
    cached.current = initialAttachments;
    cachedFailureCount.current = initialFailureCount;
    setAttachments(loadOnMount && initialAttachments ? initialAttachments : null);
    if (loadOnMount && initialAttachments) reportFailures(initialFailureCount);
  }, [initialAttachments, initialFailureCount, loadOnMount, pasteId, reportFailures]);

  useEffect(() => {
    if (!loadOnMount || initialAttachments) return;
    void load().catch((cause) => onFailure(messageOf(cause)));
  }, [initialAttachments, load, loadOnMount, onFailure]);

  async function toggle() {
    if (attachments !== null) {
      setAttachments(null);
      return;
    }
    await load();
  }

  function remove(id: string) {
    const remaining = (cached.current ?? []).filter((item) => item.stored.id !== id);
    cached.current = remaining;
    setAttachments((current) => current === null ? null : remaining);
  }

  return { attachments, load, loading, remove, toggle };
}
