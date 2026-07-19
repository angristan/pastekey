import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";

import type { StoredAttachment } from "../../../shared/protocol/attachments";
import type { StoredPaste } from "../../../shared/protocol/pastes";
import { AttachmentListResponse, PasteListResponse } from "../../../shared/schema/api";
import { StoredShare } from "../../../shared/schema/pastes";
import { ApiClient } from "../../effect/api";
import {
  decryptAttachmentMetadataEffect,
  decryptOwnedPasteEffect,
  decryptSharedPasteEffect,
} from "../../effect/crypto";
import { browserRuntime } from "../../effect/runtime";
import type { UnlockedAttachment } from "../../lib/attachments";
import { settledMapEffect } from "../../lib/concurrency";
import { messageOf } from "../../lib/format";
import type { UnlockedPaste } from "./types";

export const unlockAttachmentsEffect = Effect.fn("unlockAttachments")(function*(
  records: readonly StoredAttachment[],
  pasteKey: CryptoKey,
) {
  return yield* settledMapEffect(records, 4, (stored) =>
    decryptAttachmentMetadataEffect(pasteKey, stored).pipe(
      Effect.map((decrypted) => ({ stored, ...decrypted })),
    ));
});

/** Promise adapter retained for React hosts and compatibility callers. */
export function unlockAttachments(
  records: readonly StoredAttachment[],
  pasteKey: CryptoKey,
  options?: Effect.RunOptions,
) {
  return browserRuntime.runPromise(unlockAttachmentsEffect(records, pasteKey), options);
}

export const hydrateOwnedPastesEffect = Effect.fn("hydrateOwnedPastes")(function*(
  records: readonly StoredPaste[],
  attachmentRecords: readonly StoredAttachment[],
  accountKey: CryptoKey,
) {
  const unlocked = yield* settledMapEffect(records, 4, (stored) =>
    decryptOwnedPasteEffect(accountKey, stored).pipe(
      Effect.map((decrypted) => ({ stored, ...decrypted })),
    ));

  const attachmentsByPaste = new Map<string, StoredAttachment[]>();
  for (const attachment of attachmentRecords) {
    const current = attachmentsByPaste.get(attachment.pasteId) ?? [];
    current.push(attachment);
    attachmentsByPaste.set(attachment.pasteId, current);
  }

  const hydrated = yield* settledMapEffect(unlocked.values, 4, (paste) =>
    unlockAttachmentsEffect(attachmentsByPaste.get(paste.stored.id) ?? [], paste.pasteKey).pipe(
      Effect.map((attachments): UnlockedPaste => ({
        ...paste,
        attachments: attachments.values,
        attachmentFailureCount: attachments.failureCount,
      })),
    ));

  return {
    pastes: hydrated.values,
    failureCount: unlocked.failureCount + hydrated.failureCount,
  };
});

export const loadOwnedPastesEffect = Effect.fn("loadOwnedPastes")(function*(accountKey: CryptoKey) {
  const api = yield* ApiClient;
  const responses = yield* Effect.all({
    pastes: api.request("/api/pastes", PasteListResponse),
    attachments: api.request("/api/attachments", AttachmentListResponse),
  }, { concurrency: "unbounded" });
  return yield* hydrateOwnedPastesEffect(
    responses.pastes.pastes,
    responses.attachments.attachments,
    accountKey,
  );
});

export const loadSharedPasteEffect = Effect.fn("loadSharedPaste")(function*(
  shareId: string,
  secret: string,
) {
  const api = yield* ApiClient;
  const stored = yield* api.request(`/api/shares/${shareId}`, StoredShare);
  const unlocked = yield* decryptSharedPasteEffect(stored, secret);
  const attachments = yield* unlockAttachmentsEffect(stored.attachments, unlocked.pasteKey);
  return { stored, payload: unlocked.payload, attachments };
});

const loadPasteAttachmentsEffect = Effect.fn("loadPasteAttachments")(function*(
  pasteId: string,
  pasteKey: CryptoKey,
) {
  const api = yield* ApiClient;
  const response = yield* api.request(`/api/pastes/${pasteId}/files`, AttachmentListResponse);
  return yield* unlockAttachmentsEffect(response.attachments, pasteKey);
});

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
  const loadController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [attachments, setAttachments] = useState<UnlockedAttachment[] | null>(
    loadOnMount && initialAttachments ? initialAttachments : null,
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadController.current?.abort();
    };
  }, []);

  const reportFailures = useCallback((failureCount: number) => {
    if (!mounted.current) return;
    if (failureCount) {
      onFailure(`${failureCount} encrypted ${failureCount === 1 ? "file could" : "files could"} not be decrypted.`);
    } else {
      onFailure(null);
    }
  }, [onFailure]);

  const load = useCallback(async () => {
    if (cached.current) {
      if (mounted.current) setAttachments(cached.current);
      reportFailures(cachedFailureCount.current);
      return cached.current;
    }

    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    if (mounted.current) {
      setLoading(true);
      onFailure(null);
    }
    try {
      const result = await browserRuntime.runPromise(
        loadPasteAttachmentsEffect(pasteId, pasteKey),
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !mounted.current) return result.values;
      cached.current = result.values;
      cachedFailureCount.current = result.failureCount;
      setAttachments(result.values);
      reportFailures(result.failureCount);
      return result.values;
    } finally {
      if (loadController.current === controller) loadController.current = null;
      if (!controller.signal.aborted && mounted.current) setLoading(false);
    }
  }, [onFailure, pasteId, pasteKey, reportFailures]);

  useEffect(() => {
    loadController.current?.abort();
    cached.current = initialAttachments;
    cachedFailureCount.current = initialFailureCount;
    setAttachments(loadOnMount && initialAttachments ? initialAttachments : null);
    setLoading(false);
    if (loadOnMount && initialAttachments) reportFailures(initialFailureCount);
  }, [initialAttachments, initialFailureCount, loadOnMount, pasteId, reportFailures]);

  useEffect(() => {
    if (!loadOnMount || initialAttachments) return;
    const controller = new AbortController();
    // `load` owns its controller; aborting it is the cleanup bridge for React.
    void load().catch((cause) => {
      if (!controller.signal.aborted && mounted.current) onFailure(messageOf(cause));
    });
    return () => {
      controller.abort();
      loadController.current?.abort();
    };
  }, [initialAttachments, load, loadOnMount, onFailure]);

  async function toggle() {
    if (attachments !== null) {
      loadController.current?.abort();
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
