import "@cloudflare/kumo/styles/standalone";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  KeyIcon,
  LockKeyIcon,
} from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Brand, GitHubLink } from "../../components/Brand";
import { CenteredStatus } from "../../components/CenteredStatus";
import { browserRuntime } from "../../effect/runtime";
import type { UnlockedAttachment } from "../../lib/attachments";
import { formatDate, messageOf } from "../../lib/format";
import { shareSecretFromHash } from "../../lib/routes";
import { loadSharedPasteEffect } from "../pastes/useUnlockedAttachments";
import type { StoredShare } from "../../../shared/protocol/pastes";
import { itemKindOf, type PastePayload } from "../../../shared/protocol/pastes";

const AttachmentList = lazy(() => import("../../components/AttachmentList").then((module) => ({ default: module.AttachmentList })));

export function SharedPastePage({ shareId }: { shareId: string }) {
  const secret = shareSecretFromHash(window.location.hash);
  const [payload, setPayload] = useState<PastePayload | null>(null);
  const [metadata, setMetadata] = useState<StoredShare | null>(null);
  const [attachments, setAttachments] = useState<UnlockedAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileItem = payload ? itemKindOf(payload) === "files" : false;

  useEffect(() => {
    if (!secret) {
      setError("This link is missing its decryption key.");
      return;
    }

    const controller = new AbortController();
    void browserRuntime.runPromise(
      loadSharedPasteEffect(shareId, secret),
      { signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted) return;
      setMetadata(result.stored);
      setPayload(result.payload);
      setAttachments(result.attachments.values);
      if (result.attachments.failureCount) {
        setPanelError(
          `${result.attachments.failureCount} encrypted ${result.attachments.failureCount === 1 ? "file could" : "files could"} not be decrypted.`,
        );
      }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(messageOf(cause));
    });

    return () => controller.abort();
  }, [secret, shareId]);

  async function copy() {
    if (!payload) return;
    setPanelError(null);
    try {
      await navigator.clipboard.writeText(payload.content);
      setCopied(true);
    } catch (cause) {
      setPanelError(messageOf(cause));
    }
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
          <h1>Can’t open this share</h1>
          <p>{error}</p>
          <Button onClick={() => { window.location.href = "/"; }}>Go to Pastekey</Button>
        </LayerCard>
      ) : !payload ? (
        <CenteredStatus label="Decrypting shared item…" />
      ) : (
        <LayerCard className="shared-card">
          <div className="shared-heading">
            <div>
              <p className="eyebrow">{fileItem ? "Encrypted file drop" : "Encrypted shared paste"}</p>
              <h1>{payload.title}</h1>
              <p>
                {metadata && `Shared ${formatDate(metadata.createdAt)}`}
                {fileItem
                  ? ` · ${attachments.length} ${attachments.length === 1 ? "file" : "files"}`
                  : ` · ${payload.language}`}
              </p>
            </div>
            {!fileItem && (
              <Button variant="primary" icon={copied ? CheckIcon : CopyIcon} onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
            )}
          </div>
          {panelError && <div className="share-error">{panelError}</div>}
          {!fileItem && <pre className="shared-content"><code>{payload.content}</code></pre>}
          {(fileItem || attachments.length > 0) && (
            <Suspense fallback={<CenteredStatus label="Opening files…" compact />}>
              <AttachmentList
                attachments={attachments}
                buttonSize="sm"
                className="shared-attachments"
                downloadEndpoint={(attachment) => `/api/shares/${shareId}/files/${attachment.stored.id}/content`}
                emptyMessage="No files remain in this drop."
                onError={setPanelError}
                title={fileItem ? "Encrypted files" : "Attachments"}
              />
            </Suspense>
          )}
          <footer className="shared-footer">
            <span><KeyIcon /> End-to-end encrypted. Pastekey can’t read this {fileItem ? "file drop" : "paste"}.</span>
            <a href="/" className="text-link">Create your own <ArrowSquareOutIcon /></a>
          </footer>
        </LayerCard>
      )}
    </main>
  );
}
