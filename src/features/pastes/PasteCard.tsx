import { Badge, Button, LayerCard } from "@cloudflare/kumo";
import {
  CopyIcon,
  KeyIcon,
  PaperclipIcon,
  ShareNetworkIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";

import { AttachmentList } from "../../components/AttachmentList";
import { api } from "../../lib/api";
import type { UnlockedAttachment } from "../../lib/attachments";
import { decryptAttachmentMetadata } from "../../lib/crypto";
import { formatDate, formatExpiry, messageOf } from "../../lib/format";
import type { StoredAttachment } from "../../lib/types";
import type { UnlockedPaste } from "./types";

export function PasteCard({
  paste,
  onShare,
  onDelete,
}: {
  paste: UnlockedPaste;
  onShare: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [shares, setShares] = useState<{ id: string; createdAt: number; expiresAt: number | null }[] | null>(null);
  const [attachments, setAttachments] = useState<UnlockedAttachment[] | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const preview = paste.payload.content.split("\n").slice(0, 4).join("\n");

  async function toggleShares() {
    if (shares) return setShares(null);
    setPanelError(null);
    try {
      const result = await api<{ shares: { id: string; createdAt: number; expiresAt: number | null }[] }>(
        `/api/pastes/${paste.stored.id}/shares`,
      );
      setShares(result.shares);
    } catch (cause) {
      setPanelError(messageOf(cause));
    }
  }

  async function revokeShare(id: string) {
    try {
      await api<void>(`/api/pastes/${paste.stored.id}/shares/${id}`, { method: "DELETE" });
      setShares((current) => current?.filter((share) => share.id !== id) ?? []);
    } catch (cause) {
      setPanelError(messageOf(cause));
    }
  }

  async function toggleFiles() {
    if (attachments) return setAttachments(null);
    setPanelError(null);
    try {
      const result = await api<{ attachments: StoredAttachment[] }>(`/api/pastes/${paste.stored.id}/files`);
      setAttachments(
        await Promise.all(
          result.attachments.map(async (stored) => ({ stored, ...(await decryptAttachmentMetadata(paste.pasteKey, stored)) })),
        ),
      );
    } catch (cause) {
      setPanelError(messageOf(cause));
    }
  }

  async function removeFile(attachment: UnlockedAttachment) {
    await api<void>(`/api/pastes/${paste.stored.id}/files/${attachment.stored.id}`, { method: "DELETE" });
    setAttachments((current) => current?.filter((item) => item.stored.id !== attachment.stored.id) ?? []);
  }

  return (
    <LayerCard className="paste-card">
      <div className="paste-card-head">
        <div>
          <div className="paste-title-row">
            <h2>{paste.payload.title}</h2>
            <Badge>{paste.payload.language}</Badge>
          </div>
          <p>Updated {formatDate(paste.stored.updatedAt)} · {formatExpiry(paste.stored.expiresAt)}</p>
        </div>
        <div className="paste-actions">
          <Button size="sm" icon={ShareNetworkIcon} onClick={onShare}>Share</Button>
          <Button size="sm" variant="ghost" icon={PaperclipIcon} onClick={toggleFiles}>Files</Button>
          <Button size="sm" variant="ghost" icon={KeyIcon} onClick={toggleShares}>Links</Button>
          <Button size="sm" variant="ghost" icon={CopyIcon} onClick={() => navigator.clipboard.writeText(paste.payload.content)}>Copy</Button>
          <Button size="sm" shape="square" variant="ghost" icon={TrashIcon} aria-label="Delete paste" onClick={onDelete} />
        </div>
      </div>
      {panelError && <div className="share-error">{panelError}</div>}
      {shares && (
        <div className="share-list">
          <div>
            <strong>Active encrypted links</strong>
            <span>Secrets aren’t stored, so existing links can only be revoked.</span>
          </div>
          {shares.length === 0 ? <p>No active links.</p> : shares.map((share) => (
            <div className="share-row" key={share.id}>
              <code>{share.id.slice(0, 10)}…</code>
              <span>{formatExpiry(share.expiresAt)}</span>
              <Button size="xs" variant="secondary-destructive" onClick={() => revokeShare(share.id)}>Revoke</Button>
            </div>
          ))}
        </div>
      )}
      {attachments && (
        <AttachmentList
          attachments={attachments}
          downloadEndpoint={(attachment) => `/api/pastes/${paste.stored.id}/files/${attachment.stored.id}/content`}
          emptyMessage="No files attached."
          onDelete={removeFile}
          onError={setPanelError}
        />
      )}
      <button className="paste-preview" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <pre>{expanded ? paste.payload.content : preview}</pre>
        {!expanded && paste.payload.content.split("\n").length > 4 && <span>Show all</span>}
      </button>
    </LayerCard>
  );
}
