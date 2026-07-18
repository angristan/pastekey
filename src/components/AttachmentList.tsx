import { Button } from "@cloudflare/kumo";
import { DownloadSimpleIcon, EyeIcon, FileIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

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
  title?: string;
  buttonSize?: "xs" | "sm";
}) {
  return (
    <div className={className} id={id}>
      <strong>{title}</strong>
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
  const [preview, setPreview] = useState<{
    kind: AttachmentPreviewKind;
    text?: string;
    truncated?: boolean;
    url?: string;
  } | null>(null);
  const endpoint = downloadEndpoint(attachment);

  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview?.url]);

  async function togglePreview() {
    if (preview) {
      setPreview(null);
      return;
    }
    if (!kind) return;

    setLoadingPreview(true);
    try {
      const blob = await fetchDecryptedAttachment(endpoint, attachment);
      if (kind === "text") {
        const text = await blob.text();
        const limit = 200_000;
        setPreview({ kind, text: text.slice(0, limit), truncated: text.length > limit });
      } else {
        setPreview({ kind, url: URL.createObjectURL(blob) });
      }
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function download() {
    setDownloading(true);
    try {
      await downloadAttachment(endpoint, attachment);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setDownloading(false);
    }
  }

  async function remove() {
    if (!onDelete) return;
    setDeleting(true);
    setPreview(null);
    try {
      await onDelete(attachment);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setDeleting(false);
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
              onClick={remove}
            >
              Delete
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
