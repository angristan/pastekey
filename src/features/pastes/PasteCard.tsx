import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import {
  CaretDownIcon,
  CheckIcon,
  CopyIcon,
  DotsThreeVerticalIcon,
  DownloadSimpleIcon,
  FileIcon,
  FileTextIcon,
  KeyIcon,
  PaperclipIcon,
  ShareNetworkIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { lazy, Suspense, useState } from "react";

import { api } from "../../lib/api";
import { downloadAttachment, type UnlockedAttachment } from "../../lib/attachments";
import { formatBytes, formatDate, formatExpiry, messageOf } from "../../lib/format";
import { itemKindOf } from "../../../shared/protocol/pastes";
import type { ShareSummary } from "./share-state";
import type { UnlockedPaste } from "./types";
import { usePasteShares } from "./usePasteShares";
import { useUnlockedAttachments } from "./useUnlockedAttachments";

const AttachmentList = lazy(() => import("../../components/AttachmentList").then((module) => ({ default: module.AttachmentList })));

export function PasteCard({
  paste,
  onShare,
  onDelete,
}: {
  paste: UnlockedPaste;
  onShare: () => Promise<{ share: ShareSummary; url: string }>;
  onDelete: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [copiedPaste, setCopiedPaste] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const fileItem = itemKindOf(paste.payload) === "files";
  const {
    attachments,
    loading: loadingFiles,
    remove: removeAttachment,
    toggle: toggleFiles,
  } = useUnlockedAttachments({
    pasteId: paste.stored.id,
    pasteKey: paste.pasteKey,
    loadOnMount: fileItem,
    initialAttachments: paste.attachments,
    initialFailureCount: paste.attachmentFailureCount,
    onFailure: setPanelError,
  });
  const {
    copy: copyShareLink,
    create: createShare,
    generatedShares,
    loading: loadingShares,
    revoke: revokeShare,
    revokingId: revokingShareId,
    shares,
    sharing,
    toggle: toggleShares,
  } = usePasteShares({
    pasteId: paste.stored.id,
    createEnvelope: onShare,
    onError: setPanelError,
  });
  const primaryAttachment = attachments?.length === 1 ? attachments[0] : null;
  const generatedFileTitle = fileItem && (
    paste.payload.title === "File drop" ||
    /^\d+ encrypted files$/.test(paste.payload.title) ||
    primaryAttachment?.metadata.name === paste.payload.title
  );
  const displayTitle = generatedFileTitle && primaryAttachment ? primaryAttachment.metadata.name : paste.payload.title;
  const detailPanelId = `detail-panel-${paste.stored.id}`;
  const sharePanelId = `share-panel-${paste.stored.id}`;
  const filePanelId = `file-panel-${paste.stored.id}`;
  const itemSummary = fileItem
    ? attachments === null
      ? "Decrypting files…"
      : primaryAttachment
        ? `${formatBytes(primaryAttachment.metadata.size)} · File`
        : `${attachments.length} ${attachments.length === 1 ? "file" : "files"}`
    : paste.payload.language;

  async function removeFile(attachment: UnlockedAttachment) {
    if (!window.confirm(`Remove “${attachment.metadata.name}” from this item? This cannot be undone.`)) return;
    await api<void>(`/api/pastes/${paste.stored.id}/files/${attachment.stored.id}`, { method: "DELETE" });
    removeAttachment(attachment.stored.id);
  }

  async function copyPaste() {
    try {
      await navigator.clipboard.writeText(paste.payload.content);
      setCopiedPaste(true);
    } catch (cause) {
      setPanelError(messageOf(cause));
    }
  }

  async function downloadPrimaryFile() {
    if (!primaryAttachment) return;
    setDownloading(true);
    setPanelError(null);
    try {
      await downloadAttachment(
        `/api/pastes/${paste.stored.id}/files/${primaryAttachment.stored.id}/content`,
        primaryAttachment,
      );
    } catch (cause) {
      setPanelError(messageOf(cause));
    } finally {
      setDownloading(false);
    }
  }

  function openFileDetails() {
    setDetailsOpen(true);
  }

  return (
    <LayerCard className="vault-item">
      <div className="vault-row">
        <span className="vault-kind-icon" aria-hidden="true">
          {fileItem ? <FileIcon weight="duotone" /> : <FileTextIcon weight="duotone" />}
        </span>
        <button
          type="button"
          className="vault-summary"
          aria-expanded={detailsOpen}
          aria-controls={detailPanelId}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <strong>{displayTitle}</strong>
          <span>{itemSummary} · Updated {formatDate(paste.stored.updatedAt)} · {formatExpiry(paste.stored.expiresAt)}</span>
        </button>
        <div className="vault-actions">
          {fileItem ? (
            primaryAttachment ? (
              <>
                <Button className="desktop-vault-action" size="sm" icon={DownloadSimpleIcon} loading={downloading} onClick={downloadPrimaryFile}>Download</Button>
                <Button
                  className="mobile-vault-action"
                  size="sm"
                  shape="square"
                  icon={DownloadSimpleIcon}
                  loading={downloading}
                  aria-label={`Download ${displayTitle}`}
                  onClick={downloadPrimaryFile}
                />
              </>
            ) : (
              <>
                <Button className="desktop-vault-action" size="sm" loading={attachments === null} onClick={openFileDetails}>View files</Button>
                <Button
                  className="mobile-vault-action"
                  size="sm"
                  shape="square"
                  icon={FileIcon}
                  loading={attachments === null}
                  aria-label={`View files in ${displayTitle}`}
                  onClick={openFileDetails}
                />
              </>
            )
          ) : (
            <>
              <Button className="desktop-vault-action" size="sm" icon={copiedPaste ? CheckIcon : CopyIcon} onClick={copyPaste}>
                {copiedPaste ? "Copied" : "Copy"}
              </Button>
              <Button
                className="mobile-vault-action"
                size="sm"
                shape="square"
                icon={copiedPaste ? CheckIcon : CopyIcon}
                aria-label={copiedPaste ? `${displayTitle} copied` : `Copy ${displayTitle}`}
                onClick={copyPaste}
              />
            </>
          )}
          <Button className="desktop-vault-action" size="sm" variant="ghost" icon={ShareNetworkIcon} loading={sharing} onClick={createShare}>Share</Button>
          <Button
            className="mobile-vault-action"
            size="sm"
            shape="square"
            variant="ghost"
            icon={ShareNetworkIcon}
            loading={sharing}
            aria-label={`Share ${displayTitle}`}
            onClick={createShare}
          />
          <Button
            className="vault-detail-toggle"
            size="sm"
            shape="square"
            variant="ghost"
            icon={CaretDownIcon}
            data-state={detailsOpen ? "open" : "closed"}
            aria-label={detailsOpen ? "Hide details" : "Show details"}
            aria-expanded={detailsOpen}
            aria-controls={detailPanelId}
            onClick={() => setDetailsOpen((open) => !open)}
          />
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button
                  size="sm"
                  shape="square"
                  variant="ghost"
                  icon={DotsThreeVerticalIcon}
                  aria-label={`More actions for ${displayTitle}`}
                />
              }
            />
            <DropdownMenu.Content>
              <DropdownMenu.Item icon={KeyIcon} disabled={loadingShares} onClick={toggleShares}>
                {loadingShares ? "Loading links…" : shares === null ? "Manage links" : "Hide links"}
              </DropdownMenu.Item>
              {!fileItem && (
                <DropdownMenu.Item icon={PaperclipIcon} disabled={loadingFiles} onClick={toggleFiles}>
                  {loadingFiles ? "Loading attachments…" : attachments === null ? "Attachments" : "Hide attachments"}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator />
              <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={onDelete}>
                Delete {fileItem ? "file drop" : "paste"}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>
      </div>

      {panelError && <div className="share-error">{panelError}</div>}

      {shares !== null && (
        <div className="share-list" id={sharePanelId}>
          <div>
            <strong>Encrypted share links</strong>
            <span>Existing secrets aren’t stored, so links can be revoked but not shown again.</span>
          </div>
          {generatedShares.map((generated) => {
            const inputId = `new-share-${paste.stored.id}-${generated.shareId}`;
            return (
              <div className="new-share-link" key={generated.shareId}>
                <label htmlFor={inputId}>New link — copy it now</label>
                <div>
                  <input
                    id={inputId}
                    readOnly
                    value={generated.url}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    icon={generated.copied ? CheckIcon : CopyIcon}
                    onClick={() => copyShareLink(generated)}
                  >
                    {generated.copied ? "Copied" : "Copy link"}
                  </Button>
                </div>
              </div>
            );
          })}
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

      {!fileItem && detailsOpen && (
        <pre className="vault-text-detail" id={detailPanelId}><code>{paste.payload.content}</code></pre>
      )}

      {fileItem && detailsOpen && attachments === null && !panelError && (
        <div className="file-item-status" id={detailPanelId}>Decrypting files…</div>
      )}

      {attachments && (!fileItem || detailsOpen) && (
        <Suspense fallback={<div className="file-item-status">Opening files…</div>}>
          <AttachmentList
            attachments={attachments}
            className="attachment-list vault-file-detail"
            downloadEndpoint={(attachment) => `/api/pastes/${paste.stored.id}/files/${attachment.stored.id}/content`}
            emptyMessage={fileItem ? "No files remain in this drop." : "No files attached."}
            id={fileItem ? detailPanelId : filePanelId}
            onDelete={fileItem && attachments.length <= 1 ? undefined : removeFile}
            onError={setPanelError}
            title={fileItem ? null : "Attachments"}
          />
        </Suspense>
      )}
    </LayerCard>
  );
}
