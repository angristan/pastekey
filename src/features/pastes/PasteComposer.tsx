import { Badge, Banner, Button, Input, LayerCard, Select, Textarea } from "@cloudflare/kumo";
import { FileIcon, LockKeyIcon, PaperclipIcon } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";

import { api, jsonBody } from "../../lib/api";
import { encryptAttachment, encryptNewPaste } from "../../lib/crypto";
import { expiryTimestamp, formatBytes, messageOf, type Expiry } from "../../lib/format";
import type { AppConfig } from "../../lib/types";

export function PasteComposer({
  accountKey,
  limits,
  onCreated,
  onCancel,
}: {
  accountKey: CryptoKey;
  limits: AppConfig["limits"];
  onCreated: () => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [language, setLanguage] = useState("text");
  const [expiry, setExpiry] = useState<Expiry>("week");
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim() && files.length === 0) return setError("Add paste content or at least one file.");
    setSaving(true);
    setError(null);
    let createdPasteId: string | null = null;
    try {
      setProgress("Encrypting paste…");
      const encrypted = await encryptNewPaste(
        accountKey,
        { title: title.trim() || "Untitled paste", content, language },
        expiryTimestamp(expiry),
      );
      await api("/api/pastes", { method: "POST", ...jsonBody(encrypted.write) });
      createdPasteId = encrypted.write.id;

      for (const [index, file] of files.entries()) {
        setProgress(`Encrypting file ${index + 1} of ${files.length}…`);
        const attachment = await encryptAttachment(encrypted.pasteKey, encrypted.write.id, file);
        setProgress(`Uploading file ${index + 1} of ${files.length}…`);
        await api(`/api/pastes/${encrypted.write.id}/files/${attachment.id}`, {
          method: "PUT",
          body: attachment.body,
          headers: attachment.headers,
        });
      }

      setProgress(null);
      await onCreated();
    } catch (cause) {
      if (createdPasteId) {
        await api<void>(`/api/pastes/${createdPasteId}`, { method: "DELETE" }).catch(() => undefined);
      }
      setProgress(null);
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
            <h2>New encrypted paste</h2>
            <p>The title and content are encrypted together.</p>
          </div>
          <Badge>Local encryption</Badge>
        </div>
        {error && <Banner variant="error" description={error} />}
        <div className="composer-grid">
          <Input label="Title" placeholder="Deploy notes" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
          <Select<string> label="Format" value={language} onValueChange={(value) => value && setLanguage(value)}>
            <Select.Option value="text">Plain text</Select.Option>
            <Select.Option value="javascript">JavaScript</Select.Option>
            <Select.Option value="typescript">TypeScript</Select.Option>
            <Select.Option value="json">JSON</Select.Option>
            <Select.Option value="shell">Shell</Select.Option>
            <Select.Option value="markdown">Markdown</Select.Option>
          </Select>
          <Select<Expiry> label="Expires" value={expiry} onValueChange={(value) => value && setExpiry(value)}>
            <Select.Option value="hour">1 hour</Select.Option>
            <Select.Option value="day">1 day</Select.Option>
            <Select.Option value="week">1 week</Select.Option>
            <Select.Option value="never">Never</Select.Option>
          </Select>
        </div>
        <Textarea
          label="Paste"
          placeholder="Paste text or code here…"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={12}
          spellCheck={false}
          maxLength={500_000}
        />
        <div className="file-picker">
          <label className="file-picker-button">
            <PaperclipIcon />
            Add encrypted files
            <input
              type="file"
              multiple
              onChange={(event) => {
                const selected = Array.from(event.target.files ?? []);
                if (selected.length > limits.maxFilesPerPaste) {
                  setError(`Choose at most ${limits.maxFilesPerPaste} files.`);
                  return;
                }
                const invalid = selected.find((file) => file.size === 0 || file.size > limits.maxFileBytes);
                if (invalid) {
                  setError(`${invalid.name} must be between 1 byte and ${formatBytes(limits.maxFileBytes)}.`);
                  return;
                }
                setError(null);
                setFiles(selected);
              }}
            />
          </label>
          <span>Up to {limits.maxFilesPerPaste} files · {formatBytes(limits.maxFileBytes)} each</span>
        </div>
        {files.length > 0 && (
          <div className="selected-files">
            {files.map((file, index) => (
              <div key={`${file.name}:${file.size}:${index}`}>
                <FileIcon />
                <span>{file.name}</span>
                <small>{formatBytes(file.size)}</small>
              </div>
            ))}
          </div>
        )}
        <div className="composer-actions">
          <span><LockKeyIcon /> Encrypted with a new per-paste key</span>
          <div>
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="primary" loading={saving}>{progress ?? "Encrypt & save"}</Button>
          </div>
        </div>
      </form>
    </LayerCard>
  );
}
