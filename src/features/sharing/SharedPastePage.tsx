import { Button, LayerCard } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  DownloadSimpleIcon,
  FileIcon,
  KeyIcon,
  LockKeyIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { Brand, CenteredStatus, GitHubLink } from "../../components/Brand";
import { api } from "../../lib/api";
import { downloadAttachment, type UnlockedAttachment } from "../../lib/attachments";
import { decryptAttachmentMetadata, decryptSharedPaste } from "../../lib/crypto";
import { formatBytes, formatDate, messageOf } from "../../lib/format";
import type { PastePayload, StoredShare } from "../../lib/types";

export function SharedPastePage({ shareId }: { shareId: string }) {
  const secret = window.location.hash.slice(1);
  const [payload, setPayload] = useState<PastePayload | null>(null);
  const [metadata, setMetadata] = useState<StoredShare | null>(null);
  const [attachments, setAttachments] = useState<UnlockedAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!secret) {
      setError("This link is missing its decryption key.");
      return;
    }
    api<StoredShare>(`/api/shares/${shareId}`)
      .then(async (stored) => {
        setMetadata(stored);
        const unlocked = await decryptSharedPaste(stored, secret);
        setPayload(unlocked.payload);
        setAttachments(
          await Promise.all(
            stored.attachments.map(async (attachment) => ({
              stored: attachment,
              ...(await decryptAttachmentMetadata(unlocked.pasteKey, attachment)),
            })),
          ),
        );
      })
      .catch((cause) => setError(messageOf(cause)));
  }, [secret, shareId]);

  async function copy() {
    if (!payload) return;
    await navigator.clipboard.writeText(payload.content);
    setCopied(true);
  }

  return (
    <main className="shared-shell">
      <header className="app-header">
        <a href="/" className="brand-link"><Brand /></a>
        <div className="header-actions">
          <span className="encrypted-state"><LockKeyIcon weight="fill" /> Decrypted locally</span>
          <GitHubLink />
        </div>
      </header>
      {error ? (
        <LayerCard className="auth-card shared-error">
          <LockKeyIcon size={36} weight="duotone" />
          <h1>Can’t open this paste</h1>
          <p>{error}</p>
          <Button onClick={() => { window.location.href = "/"; }}>Go to Pastekey</Button>
        </LayerCard>
      ) : !payload ? (
        <CenteredStatus label="Decrypting shared paste…" />
      ) : (
        <LayerCard className="shared-card">
          <div className="shared-heading">
            <div>
              <p className="eyebrow">Encrypted shared paste</p>
              <h1>{payload.title}</h1>
              <p>{metadata && `Shared ${formatDate(metadata.createdAt)}`} · {payload.language}</p>
            </div>
            <Button variant="primary" icon={copied ? CheckIcon : CopyIcon} onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
          </div>
          <pre className="shared-content"><code>{payload.content}</code></pre>
          {attachments.length > 0 && (
            <div className="shared-attachments">
              <strong>Attachments</strong>
              {attachments.map((attachment) => (
                <div className="attachment-row" key={attachment.stored.id}>
                  <FileIcon />
                  <span>{attachment.metadata.name}</span>
                  <small>{formatBytes(attachment.metadata.size)}</small>
                  <Button
                    size="sm"
                    icon={DownloadSimpleIcon}
                    onClick={() => downloadAttachment(
                      `/api/shares/${shareId}/files/${attachment.stored.id}/content`,
                      attachment,
                    ).catch((cause) => setError(messageOf(cause)))}
                  >
                    Download
                  </Button>
                </div>
              ))}
            </div>
          )}
          <footer className="shared-footer">
            <span><KeyIcon /> End-to-end encrypted. Pastekey can’t read this paste.</span>
            <a href="/" className="text-link">Create your own <ArrowSquareOutIcon /></a>
          </footer>
        </LayerCard>
      )}
    </main>
  );
}
