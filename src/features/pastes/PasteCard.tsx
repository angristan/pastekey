import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import {
  CheckIcon,
  CopyIcon,
  KeyIcon,
  PaperclipIcon,
  ShareNetworkIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { UnlockedAttachment } from "../../lib/attachments";
import { decryptAttachmentMetadata } from "../../lib/crypto";
import { formatDate, formatExpiry, messageOf } from "../../lib/format";
import { itemKindOf, type StoredAttachment } from "../../lib/types";
import type { UnlockedPaste } from "./types";

const AttachmentList = lazy(() => import("../../components/AttachmentList").then((module) => ({ default: module.AttachmentList })));

type ShareSummary = {
  id: string;
  createdAt: number;
  expiresAt: number | null;
};

export function PasteCard({
  paste,
  onShare,
  onDelete,
}: {
  paste: UnlockedPaste;
  onShare: () => Promise<{ share: ShareSummary; url: string }>;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  const [attachments, setAttachments] = useState<UnlockedAttachment[] | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [newShareUrl, setNewShareUrl] = useState<string | null>(null);
  const [copiedPaste, setCopiedPaste] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [loadingShares, setLoadingShares] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [revokingShareId, setRevokingShareId] = useState<string | null>(null);
  const fileItem = itemKindOf(paste.payload) === "files";
  const autoFileTitle = fileItem && (
    /^\d+ encrypted files$/.test(paste.payload.title) ||
    (attachments?.length === 1 && attachments[0]?.metadata.name === paste.payload.title)
  );
  const displayTitle = autoFileTitle ? "File drop" : paste.payload.title;
  const fileCount = attachments?.length;
  const badge = fileItem
    ? (fileCount === undefined ? "File drop" : `${fileCount} ${fileCount === 1 ? "file" : "files"}`)
    : paste.payload.language;
  const preview = paste.payload.content.split("\n").slice(0, 4).join("\n");
  const sharePanelId = `share-panel-${paste.stored.id}`;
  const filePanelId = `file-panel-${paste.stored.id}`;

  useEffect(() => {
    if (!fileItem) return;
    let active = true;
    setPanelError(null);
    loadAttachments()
      .then((items) => active && setAttachments(items))
      .catch((cause) => active && setPanelError(messageOf(cause)));
    return () => { active = false; };
  }, [fileItem, paste.stored.id, paste.pasteKey]);

  async function loadShares() {
    const result = await api<{ shares: ShareSummary[] }>(`/api/pastes/${paste.stored.id}/shares`);
    return result.shares;
  }

  async function toggleShares() {
    if (shares !== null) {
      setShares(null);
      return;
    }
    setPanelError(null);
    setLoadingShares(true);
    try {
      setShares(await loadShares());
    } catch (cause) {
      setPanelError(messageOf(cause));
    } finally {
      setLoadingShares(false);
    }
  }

  async function createShare() {
    setPanelError(null);
    setSharing(true);
    try {
      const created = await onShare();
      setShares((current) => [created.share, ...(current ?? [])]);
      setNewShareUrl(created.url);
      setCopiedLink(false);
    } catch (cause) {
      setPanelError(messageOf(cause));
    } finally {
      setSharing(false);
    }
  }

  async function copyShareLink() {
    if (!newShareUrl) return;
    try {
      await navigator.clipboard.writeText(newShareUrl);
      setCopiedLink(true);
    } catch (cause) {
      setPanelError(messageOf(cause));
    }
  }

  async function revokeShare(id: string) {
    if (!window.confirm("Revoke this share link? Anyone using it will immediately lose access.")) return;
    setPanelError(null);
    setRevokingShareId(id);
    try {
      await api<void>(`/api/pastes/${paste.stored.id}/shares/${id}`, { method: "DELETE" });
      setShares((current) => current?.filter((share) => share.id !== id) ?? []);
      if (newShareUrl?.includes(`/s/${id}#`)) setNewShareUrl(null);
    } catch (cause) {
      setPanelError(messageOf(cause));
    } finally {
      setRevokingShareId(null);
    }
  }

  async function loadAttachments() {
    const result = await api<{ attachments: StoredAttachment[] }>(`/api/pastes/${paste.stored.id}/files`);
    return Promise.all(
      result.attachments.map(async (stored) => ({ stored, ...(await decryptAttachmentMetadata(paste.pasteKey, stored)) })),
    );
  }

  async function toggleFiles() {
    if (attachments !== null) {
      setAttachments(null);
      return;
    }
    setPanelError(null);
    setLoadingFiles(true);
    try {
      setAttachments(await loadAttachments());
    } catch (cause) {
      setPanelError(messageOf(cause));
    } finally {
      setLoadingFiles(false);
    }
  }

  async function removeFile(attachment: UnlockedAttachment) {
    if (!window.confirm(`Remove “${attachment.metadata.name}” from this item? This cannot be undone.`)) return;
    await api<void>(`/api/pastes/${paste.stored.id}/files/${attachment.stored.id}`, { method: "DELETE" });
    setAttachments((current) => current?.filter((item) => item.stored.id !== attachment.stored.id) ?? []);
  }

  async function copyPaste() {
    try {
      await navigator.clipboard.writeText(paste.payload.content);
      setCopiedPaste(true);
    } catch (cause) {
      setPanelError(messageOf(cause));
    }
  }

  return (
    <LayerCard className={`paste-card${fileItem ? " file-drop-card" : ""}`}>
      <div className="paste-card-head">
        <div>
          <div className="paste-title-row">
            <h2>{displayTitle}</h2>
            <Badge>{badge}</Badge>
          </div>
          <p>Updated {formatDate(paste.stored.updatedAt)} · {formatExpiry(paste.stored.expiresAt)}</p>
        </div>
        <div className="paste-actions">
          <Button size="sm" icon={ShareNetworkIcon} loading={sharing} onClick={createShare}>Share</Button>
          <Button
            size="sm"
            variant="ghost"
            icon={KeyIcon}
            loading={loadingShares}
            data-state={shares !== null ? "open" : "closed"}
            aria-expanded={shares !== null}
            aria-controls={sharePanelId}
            onClick={toggleShares}
          >
            Manage links
          </Button>
          {!fileItem && (
            <Button
              size="sm"
              variant="ghost"
              icon={PaperclipIcon}
              loading={loadingFiles}
              aria-expanded={attachments !== null}
              aria-controls={filePanelId}
              onClick={toggleFiles}
            >
              Attachments
            </Button>
          )}
          {!fileItem && (
            <Button size="sm" variant="ghost" icon={copiedPaste ? CheckIcon : CopyIcon} onClick={copyPaste}>
              {copiedPaste ? "Copied" : "Copy"}
            </Button>
          )}
          <Button
            size="sm"
            shape="square"
            variant="ghost"
            icon={TrashIcon}
            aria-label={`Delete ${fileItem ? "file drop" : "paste"}`}
            onClick={onDelete}
          />
        </div>
      </div>
      {panelError && <div className="share-error">{panelError}</div>}
      {shares !== null && (
        <div className="share-list" id={sharePanelId}>
          <div>
            <strong>Encrypted share links</strong>
            <span>Existing secrets aren’t stored, so links can be revoked but not shown again.</span>
          </div>
          {newShareUrl && (
            <div className="new-share-link">
              <label htmlFor={`new-share-${paste.stored.id}`}>New link — copy it now</label>
              <div>
                <input
                  id={`new-share-${paste.stored.id}`}
                  readOnly
                  value={newShareUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button size="sm" variant="primary" icon={copiedLink ? CheckIcon : CopyIcon} onClick={copyShareLink}>
                  {copiedLink ? "Copied" : "Copy link"}
                </Button>
              </div>
            </div>
          )}
          {shares.length === 0 ? <p>No active links.</p> : shares.map((share) => (
            <div className="share-row" key={share.id}>
              <code>{share.id.slice(0, 10)}…</code>
              <span>{formatExpiry(share.expiresAt)}</span>
              <Button
                size="xs"
                variant="secondary-destructive"
                loading={revokingShareId === share.id}
                onClick={() => revokeShare(share.id)}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
      {fileItem && attachments === null && !panelError && (
        <div className="file-item-status">Decrypting files…</div>
      )}
      {attachments && (
        <Suspense fallback={<div className="file-item-status">Opening files…</div>}>
          <AttachmentList
            attachments={attachments}
            className="attachment-list"
            downloadEndpoint={(attachment) => `/api/pastes/${paste.stored.id}/files/${attachment.stored.id}/content`}
            emptyMessage={fileItem ? "No files remain in this drop." : "No files attached."}
            id={filePanelId}
            onDelete={fileItem && attachments.length <= 1 ? undefined : removeFile}
            onError={setPanelError}
            title={fileItem ? null : "Encrypted attachments"}
          />
        </Suspense>
      )}
      {!fileItem && (
        <button className="paste-preview" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <pre>{expanded ? paste.payload.content : preview}</pre>
          {!expanded && paste.payload.content.split("\n").length > 4 && <span>Show all</span>}
        </button>
      )}
    </LayerCard>
  );
}
