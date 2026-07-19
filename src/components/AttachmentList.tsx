import { Button } from "@cloudflare/kumo/components/button";
import { DownloadSimpleIcon, EyeIcon, FileIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import {
  attachmentPreviewKind,
  downloadAttachment,
  fetchDecryptedAttachment,
  type AttachmentPreviewKind,
  type UnlockedAttachment,
} from "../lib/attachments";
import { formatBytes, messageOf } from "../lib/format";

export function AttachmentList({
  attachments,
  className = "attachment-list",
  downloadEndpoint,
  emptyMessage,
  id,
  onDelete,
  onError,
  title = "Encrypted attachments",
  buttonSize = "xs",
}: {
  attachments: UnlockedAttachment[];
  className?: string;
  downloadEndpoint: (attachment: UnlockedAttachment) => string;
  emptyMessage?: string;
  id?: string;
  onDelete?: (attachment: UnlockedAttachment) => Promise<void>;
  onError: (message: string) => void;
  title?: string | null;
  buttonSize?: "xs" | "sm";
}) {
  return (
    <div className={className} id={id}>
      {title && <strong>{title}</strong>}
      {attachments.length === 0 && emptyMessage ? <p>{emptyMessage}</p> : attachments.map((attachment) => (
        <AttachmentRow
          key={attachment.stored.id}
          attachment={attachment}
          buttonSize={buttonSize}
          downloadEndpoint={downloadEndpoint}
          onDelete={onDelete}
          onError={onError}
        />
      ))}
    </div>
  );
}

function AttachmentRow({
  attachment,
  buttonSize,
  downloadEndpoint,
  onDelete,
  onError,
}: {
  attachment: UnlockedAttachment;
  buttonSize: "xs" | "sm";
  downloadEndpoint: (attachment: UnlockedAttachment) => string;
  onDelete?: (attachment: UnlockedAttachment) => Promise<void>;
  onError: (message: string) => void;
}) {
  const kind = attachmentPreviewKind(attachment.metadata.type);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mounted = useRef(true);
  const previewController = useRef<AbortController | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const previewUrl = useRef<string | null>(null);
  const [preview, setPreview] = useState<{
    kind: AttachmentPreviewKind;
    text?: string;
    truncated?: boolean;
    url?: string;
  } | null>(null);
  const endpoint = downloadEndpoint(attachment);

  function clearPreview() {
    previewController.current?.abort();
    previewController.current = null;
    if (previewUrl.current) {
      URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = null;
    }
    if (mounted.current) {
      setPreview(null);
      setLoadingPreview(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      previewController.current?.abort();
      downloadController.current?.abort();
      if (previewUrl.current) {
        URL.revokeObjectURL(previewUrl.current);
        previewUrl.current = null;
      }
    };
  }, []);

  async function togglePreview() {
    if (preview) {
      clearPreview();
      return;
    }
    if (!kind) return;

    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    setLoadingPreview(true);
    try {
      const blob = await fetchDecryptedAttachment(endpoint, attachment, { signal: controller.signal });
      if (kind === "text") {
        const text = await blob.text();
        if (controller.signal.aborted || !mounted.current) return;
        const limit = 200_000;
        setPreview({ kind, text: text.slice(0, limit), truncated: text.length > limit });
      } else {
        if (controller.signal.aborted || !mounted.current) return;
        const url = URL.createObjectURL(blob);
        previewUrl.current = url;
        setPreview({ kind, url });
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) onError(messageOf(cause));
    } finally {
      if (previewController.current === controller) previewController.current = null;
      if (!controller.signal.aborted && mounted.current) setLoadingPreview(false);
    }
  }

  async function download() {
    downloadController.current?.abort();
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(true);
    try {
      await downloadAttachment(endpoint, attachment, { signal: controller.signal });
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) onError(messageOf(cause));
    } finally {
      if (downloadController.current === controller) downloadController.current = null;
      if (!controller.signal.aborted && mounted.current) setDownloading(false);
    }
  }

  async function remove() {
    if (!onDelete) return;
    setDeleting(true);
    clearPreview();
    try {
      await onDelete(attachment);
    } catch (cause) {
      if (mounted.current) onError(messageOf(cause));
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }

  return (
    <>
      <div className="attachment-row">
        <FileIcon />
        <span>{attachment.metadata.name}</span>
        <small>{formatBytes(attachment.metadata.size)}</small>
        <div className="attachment-actions">
          {kind && (
            <Button
              size={buttonSize}
              variant="ghost"
              icon={preview ? XIcon : EyeIcon}
              loading={loadingPreview}
              onClick={togglePreview}
            >
              {preview ? "Close" : "Preview"}
            </Button>
          )}
          <Button
            size={buttonSize}
            icon={DownloadSimpleIcon}
            loading={downloading}
            onClick={download}
          >
            Download
          </Button>
          {onDelete && (
            <Button
              size={buttonSize}
              variant="secondary-destructive"
              loading={deleting}
              aria-label={`Remove ${attachment.metadata.name}`}
              onClick={remove}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      {preview && (
        <div className={`attachment-preview attachment-preview-${preview.kind}`}>
          {preview.kind === "image" && <img src={preview.url} alt={attachment.metadata.name} />}
          {preview.kind === "audio" && <audio src={preview.url} controls preload="metadata" />}
          {preview.kind === "video" && <video src={preview.url} controls preload="metadata" />}
          {preview.kind === "text" && (
            <>
              <pre>{preview.text}</pre>
              {preview.truncated && <small>Preview limited to the first 200,000 characters.</small>}
            </>
          )}
        </div>
      )}
    </>
  );
}
