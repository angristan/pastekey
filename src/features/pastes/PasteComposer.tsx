import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import { ArrowClockwiseIcon, FileIcon, LockKeyIcon, PaperclipIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";

import type { AppConfig } from "../../../shared/protocol/config";
import { PasteCreateResponse } from "../../../shared/schema/api";
import type { ItemKind } from "../../../shared/protocol/pastes";
import { requestApi } from "../../effect/runtime";
import { jsonBody } from "../../lib/api";
import { encryptNewPaste } from "../../lib/crypto";
import { expiryTimestamp, formatBytes, messageOf, type Expiry } from "../../lib/format";
import {
  discardUploadSession,
  type SelectedFile,
  uploadUntilFailure,
  useUploadSession,
} from "./useUploadSession";

export function PasteComposer({
  accountKey,
  kind,
  limits,
  onCreated,
  onCancel,
}: {
  accountKey: CryptoKey;
  kind: ItemKind;
  limits: AppConfig["limits"];
  onCreated: () => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [language, setLanguage] = useState("text");
  const [expiry, setExpiry] = useState<Expiry>("week");
  const [showAttachments, setShowAttachments] = useState(kind === "files");
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const {
    appendFiles,
    beginSession,
    files,
    finishSession,
    removeFile,
    session: uploadSession,
    uploadFile,
  } = useUploadSession();
  const [error, setError] = useState<string | null>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!uploadSession) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [uploadSession]);

  function addFiles(selected: File[]) {
    if (saving || uploadSession || selected.length === 0) return;
    if (files.length + selected.length > limits.maxFilesPerPaste) {
      setError(`Choose at most ${limits.maxFilesPerPaste} files.`);
      return;
    }
    const invalid = selected.find((file) => file.size === 0 || file.size > limits.maxFileBytes);
    if (invalid) {
      setError(`${invalid.name} must be between 1 byte and ${formatBytes(limits.maxFileBytes)}.`);
      return;
    }
    setError(null);
    appendFiles(selected);
  }

  function enterDropzone(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (saving || uploadSession) return;
    dragDepth.current += 1;
    setDragging(true);
  }

  function leaveDropzone(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function dropFiles(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  async function finishCreation() {
    finishSession();
    setProgress("Refreshing vault…");
    await onCreated();
  }

  async function retryFiles(targets: SelectedFile[]) {
    if (!uploadSession || targets.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { attemptedIds, failedIds } = await uploadUntilFailure(
        targets,
        (selected) => uploadFile(selected, uploadSession),
      );
      const remaining = files.filter((selected) =>
        selected.phase !== "complete" && (!attemptedIds.has(selected.id) || failedIds.has(selected.id)),
      ).length;
      if (remaining === 0) {
        await finishCreation();
      } else {
        setError(`${remaining} ${remaining === 1 ? "file" : "files"} could not be uploaded. Review the error, then retry or discard.`);
      }
    } finally {
      setProgress(null);
      setSaving(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (uploadSession) {
      await retryFiles(files.filter((selected) => selected.phase !== "complete"));
      return;
    }
    if (kind === "paste" && !content.trim()) return setError("Add some paste content.");
    if (kind === "files" && files.length === 0) return setError("Choose at least one file.");

    setSaving(true);
    setError(null);
    try {
      setProgress(kind === "files" ? "Encrypting file drop…" : "Encrypting paste…");
      const fallbackTitle = kind === "files" ? "File drop" : "Untitled paste";
      const encrypted = await encryptNewPaste(
        accountKey,
        {
          kind,
          title: (title.trim() || fallbackTitle).slice(0, 120),
          content: kind === "paste" ? content : "",
          language: kind === "paste" ? language : "files",
        },
        expiryTimestamp(expiry),
      );
      await requestApi("/api/pastes", PasteCreateResponse, { method: "POST", ...jsonBody(encrypted.write) });

      if (files.length === 0) {
        await finishCreation();
        return;
      }

      const session = { pasteId: encrypted.write.id, pasteKey: encrypted.pasteKey };
      beginSession(session);
      setProgress(null);
      const { failedIds } = await uploadUntilFailure(
        files,
        (selected) => uploadFile(selected, session),
      );
      if (failedIds.size) {
        setError("Upload paused after a file failed. Retry to continue or discard the unfinished item.");
        return;
      }
      await finishCreation();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setProgress(null);
      setSaving(false);
    }
  }

  async function cancel() {
    if (saving) return;
    if (!uploadSession) {
      onCancel();
      return;
    }
    if (!window.confirm("Discard this unfinished upload and delete files that already uploaded?")) return;

    setSaving(true);
    setError(null);
    try {
      await discardUploadSession(uploadSession.pasteId);
      finishSession();
      onCancel();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <LayerCard className="composer-card">
      <form onSubmit={submit}>
        <div className="composer-heading">
          <div>
            <h2>{kind === "files" ? "New encrypted file drop" : "New encrypted paste"}</h2>
            <p>{kind === "files"
              ? "File names, types, and contents are encrypted locally."
              : "The title and content are encrypted together."}</p>
          </div>
          <Badge>Local encryption</Badge>
        </div>
        {error && <Banner variant="error" description={error} />}
        <div className={`composer-grid${kind === "files" ? " file-composer-grid" : ""}`}>
          <Input
            label="Title"
            placeholder={kind === "files" ? "Design assets (optional)" : "Deploy notes"}
            value={title}
            disabled={saving || Boolean(uploadSession)}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
          />
          {kind === "paste" && (
            <Select<string>
              label="Format"
              value={language}
              disabled={saving || Boolean(uploadSession)}
              onValueChange={(value) => value && setLanguage(value)}
            >
              <Select.Option value="text">Plain text</Select.Option>
              <Select.Option value="javascript">JavaScript</Select.Option>
              <Select.Option value="typescript">TypeScript</Select.Option>
              <Select.Option value="json">JSON</Select.Option>
              <Select.Option value="shell">Shell</Select.Option>
              <Select.Option value="markdown">Markdown</Select.Option>
            </Select>
          )}
          <Select<Expiry>
            label="Expires"
            value={expiry}
            disabled={saving || Boolean(uploadSession)}
            onValueChange={(value) => value && setExpiry(value)}
          >
            <Select.Option value="hour">1 hour</Select.Option>
            <Select.Option value="day">1 day</Select.Option>
            <Select.Option value="week">1 week</Select.Option>
            <Select.Option value="never">Never</Select.Option>
          </Select>
        </div>
        {kind === "paste" && (
          <Textarea
            label="Paste"
            placeholder="Paste text or code here…"
            value={content}
            disabled={saving || Boolean(uploadSession)}
            onChange={(event) => setContent(event.target.value)}
            rows={12}
            spellCheck={false}
            maxLength={500_000}
          />
        )}
        {kind === "paste" && !showAttachments && (
          <div className="optional-attachments">
            <Button type="button" variant="ghost" icon={PaperclipIcon} onClick={() => setShowAttachments(true)}>
              Attach files (optional)
            </Button>
          </div>
        )}
        {showAttachments && (
          <>
            {!uploadSession && (
              <label
                className={`file-dropzone${dragging ? " dragging" : ""}${saving ? " disabled" : ""}`}
                onDragEnter={enterDropzone}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={leaveDropzone}
                onDrop={dropFiles}
              >
                <PaperclipIcon size={22} />
                <strong>Drop files here or choose files</strong>
                <span>Up to {limits.maxFilesPerPaste} files · {formatBytes(limits.maxFileBytes)} each</span>
                <input
                  type="file"
                  multiple
                  disabled={saving || files.length >= limits.maxFilesPerPaste}
                  onChange={(event) => {
                    addFiles(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            )}
            {uploadSession && (
              <div className="file-upload-note">Successful files are kept while you retry. Finish or discard before leaving this page.</div>
            )}
            {files.length > 0 && (
              <div className="selected-files" aria-live="polite">
                {files.map((selected) => (
                  <div className={`selected-file ${selected.phase}`} key={selected.id}>
                    <FileIcon />
                    <div className="selected-file-details">
                      <span>{selected.file.name}</span>
                      <small title={selected.error}>{formatBytes(selected.file.size)} · {fileStatus(selected)}</small>
                      {(selected.phase === "uploading" || selected.phase === "retrying") && (
                        <progress max={100} value={selected.progress} aria-label={`${selected.file.name} upload progress`} />
                      )}
                    </div>
                    <div className="selected-file-actions">
                      {selected.phase === "error" && uploadSession && (
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          icon={ArrowClockwiseIcon}
                          disabled={saving}
                          onClick={() => retryFiles([selected])}
                        >
                          Retry
                        </Button>
                      )}
                      {!uploadSession && (
                        <Button
                          type="button"
                          size="xs"
                          shape="square"
                          variant="ghost"
                          icon={XIcon}
                          disabled={saving}
                          aria-label={`Remove ${selected.file.name}`}
                          onClick={() => removeFile(selected.id)}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <div className="composer-actions">
          <span><LockKeyIcon /> Encrypted with a new per-item key</span>
          <div>
            <Button type="button" variant="ghost" disabled={saving} onClick={cancel}>
              {uploadSession ? "Discard upload" : "Cancel"}
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              disabled={Boolean(uploadSession && !files.some((selected) => selected.phase === "error"))}
            >
              {progress ?? (uploadSession ? "Retry failed uploads" : kind === "files" ? "Encrypt & upload" : "Encrypt & save")}
            </Button>
          </div>
        </div>
      </form>
    </LayerCard>
  );
}

function fileStatus(selected: SelectedFile) {
  switch (selected.phase) {
    case "pending": return "Ready";
    case "encrypting": return "Encrypting locally…";
    case "uploading": return `Uploading ${selected.progress}%`;
    case "retrying": return `Connection interrupted · retry ${selected.attempt} of ${selected.maxAttempts}`;
    case "complete": return "Uploaded";
    case "error": return selected.error ?? "Upload failed";
  }
}
