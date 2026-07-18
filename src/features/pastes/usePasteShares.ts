import { useState } from "react";

import { api } from "../../lib/api";
import { messageOf } from "../../lib/format";
import { mergeShares, type GeneratedShare, type ShareSummary } from "./share-state";

export function usePasteShares({
  pasteId,
  createEnvelope,
  onError,
}: {
  pasteId: string;
  createEnvelope: () => Promise<{ share: ShareSummary; url: string }>;
  onError: (message: string | null) => void;
}) {
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  const [generatedShares, setGeneratedShares] = useState<GeneratedShare[]>([]);
  const [sharing, setSharing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function load() {
    const result = await api<{ shares: ShareSummary[] }>(`/api/pastes/${pasteId}/shares`);
    return result.shares;
  }

  async function toggle() {
    if (shares !== null) {
      setShares(null);
      return;
    }
    onError(null);
    setLoading(true);
    try {
      setShares(await load());
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function create() {
    onError(null);
    setSharing(true);
    try {
      const existing = shares ?? await load();
      const created = await createEnvelope();
      setShares(mergeShares([created.share], existing));
      setGeneratedShares((current) => [
        { shareId: created.share.id, url: created.url, copied: false },
        ...current,
      ]);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setSharing(false);
    }
  }

  async function copy(generated: GeneratedShare) {
    try {
      await navigator.clipboard.writeText(generated.url);
      setGeneratedShares((current) => current.map((share) =>
        share.shareId === generated.shareId ? { ...share, copied: true } : share,
      ));
    } catch (cause) {
      onError(messageOf(cause));
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revoke this share link? Anyone using it will immediately lose access.")) return;
    onError(null);
    setRevokingId(id);
    try {
      await api<void>(`/api/pastes/${pasteId}/shares/${id}`, { method: "DELETE" });
      setShares((current) => current?.filter((item) => item.id !== id) ?? []);
      setGeneratedShares((current) => current.filter(({ shareId }) => shareId !== id));
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setRevokingId(null);
    }
  }

  return {
    copy,
    create,
    generatedShares,
    loading,
    revoke,
    revokingId,
    shares,
    sharing,
    toggle,
  };
}
