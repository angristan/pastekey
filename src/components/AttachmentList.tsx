import { Button } from "@cloudflare/kumo";
import { DownloadSimpleIcon, FileIcon } from "@phosphor-icons/react";

import { downloadAttachment, type UnlockedAttachment } from "../lib/attachments";
import { formatBytes, messageOf } from "../lib/format";

export function AttachmentList({
  attachments,
  className = "attachment-list",
  downloadEndpoint,
  emptyMessage,
  onDelete,
  onError,
  title = "Encrypted attachments",
  buttonSize = "xs",
}: {
  attachments: UnlockedAttachment[];
  className?: string;
  downloadEndpoint: (attachment: UnlockedAttachment) => string;
  emptyMessage?: string;
  onDelete?: (attachment: UnlockedAttachment) => Promise<void>;
  onError: (message: string) => void;
  title?: string;
  buttonSize?: "xs" | "sm";
}) {
  return (
    <div className={className}>
      <strong>{title}</strong>
      {attachments.length === 0 && emptyMessage ? <p>{emptyMessage}</p> : attachments.map((attachment) => (
        <div className="attachment-row" key={attachment.stored.id}>
          <FileIcon />
          <span>{attachment.metadata.name}</span>
          <small>{formatBytes(attachment.metadata.size)}</small>
          <Button
            size={buttonSize}
            icon={DownloadSimpleIcon}
            onClick={() => downloadAttachment(downloadEndpoint(attachment), attachment)
              .catch((cause) => onError(messageOf(cause)))}
          >
            Download
          </Button>
          {onDelete && (
            <Button
              size={buttonSize}
              variant="secondary-destructive"
              onClick={() => onDelete(attachment).catch((cause) => onError(messageOf(cause)))}
            >
              Delete
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
