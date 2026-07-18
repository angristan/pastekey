import {
  Badge,
  Banner,
  Button,
  Input,
  LayerCard,
  LinkButton,
  Select,
  Textarea,
} from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  DownloadSimpleIcon,
  FileIcon,
  FingerprintIcon,
  GithubLogoIcon,
  KeyIcon,
  LockKeyIcon,
  PaperclipIcon,
  PlusIcon,
  ShareNetworkIcon,
  SignOutIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { api, jsonBody } from "./lib/api";
import {
  createShareEnvelope,
  decryptAttachmentContent,
  decryptAttachmentMetadata,
  decryptOwnedPaste,
  decryptSharedPaste,
  encryptAttachment,
  encryptNewPaste,
} from "./lib/crypto";
import { registerPasskey, unlockWithPasskey } from "./lib/passkeys";
import type {
  AppConfig,
  AttachmentMetadata,
  MeResponse,
  PastePayload,
  StoredAttachment,
  StoredPaste,
  StoredShare,
} from "./lib/types";
import { Turnstile } from "./Turnstile";

type UnlockedPaste = {
  stored: StoredPaste;
  payload: PastePayload;
  pasteKey: CryptoKey;
};

type UnlockedAttachment = {
  stored: StoredAttachment;
  metadata: AttachmentMetadata;
  fileKey: CryptoKey;
};

type Expiry = "hour" | "day" | "week" | "never";

export default function App() {
  const shareId = shareIdFromPath();
  if (shareId) return <SharedPastePage shareId={shareId} />;
  return <VaultApp />;
}

function VaultApp() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [accountKey, setAccountKey] = useState<CryptoKey | null>(null);
  const [busy, setBusy] = useState<"register" | "unlock" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    setMe(await api<MeResponse>("/api/auth/me"));
  }, []);

  useEffect(() => {
    Promise.all([
      refreshMe(),
      api<AppConfig>("/api/config").then(setConfig),
    ]).catch((cause) => setError(messageOf(cause)));
  }, [refreshMe]);

  async function authenticate(mode: "register" | "unlock", turnstileToken?: string) {
    setBusy(mode);
    setError(null);
    try {
      const result = mode === "register" ? await registerPasskey(undefined, turnstileToken) : await unlockWithPasskey();
      setAccountKey(result.accountKey);
      await refreshMe();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    await api<void>("/api/auth/logout", { method: "POST" });
    setAccountKey(null);
    setMe({ authenticated: false });
  }

  if (!me || !config) {
    return <CenteredStatus label="Opening Pastekey…" />;
  }

  if (!me.authenticated) {
    return (
      <Landing
        busy={busy}
        config={config}
        error={error}
        onRegister={(token) => authenticate("register", token)}
        onUnlock={() => authenticate("unlock")}
      />
    );
  }

  if (!accountKey) {
    return (
      <LockedVault
        busy={busy === "unlock"}
        error={error}
        onUnlock={() => authenticate("unlock")}
        onLogout={logout}
      />
    );
  }

  return <Dashboard accountKey={accountKey} config={config} me={me} onLogout={logout} onRefreshMe={refreshMe} />;
}

function Landing({
  busy,
  config,
  error,
  onRegister,
  onUnlock,
}: {
  busy: "register" | "unlock" | null;
  config: AppConfig;
  error: string | null;
  onRegister: (token?: string) => Promise<void>;
  onUnlock: () => void;
}) {
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [challengeVersion, setChallengeVersion] = useState(0);

  async function register() {
    await onRegister(turnstileToken ?? undefined);
    setTurnstileToken(null);
    setChallengeVersion((value) => value + 1);
  }

  return (
    <main className="landing shell">
      <header className="brandbar">
        <Brand />
        <div className="header-actions">
          <Badge>Preview</Badge>
          <GitHubLink />
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">No passwords. No plaintext.</p>
          <h1>Paste something.<br />Keep the key.</h1>
          <p className="hero-description">
            An end-to-end encrypted pastebin unlocked by your passkey. Cloudflare stores ciphertext—not your words.
          </p>
          {config.turnstileSiteKey && (
            <Turnstile key={challengeVersion} siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} />
          )}
          <div className="hero-actions">
            <Button
              variant="primary"
              size="lg"
              icon={PlusIcon}
              loading={busy === "register"}
              disabled={Boolean(config.turnstileSiteKey && !turnstileToken)}
              onClick={register}
            >
              Create a vault
            </Button>
            <Button size="lg" icon={FingerprintIcon} loading={busy === "unlock"} onClick={onUnlock}>
              Unlock
            </Button>
          </div>
          {error && <Banner variant="error" title="Could not continue" description={error} />}
        </div>

        <LayerCard className="security-card">
          <div className="security-visual">
            <div className="key-orbit"><KeyIcon size={38} weight="duotone" /></div>
            <div className="cipher-lines" aria-hidden="true">
              <span>7f 2a 91 c8 04 e3</span>
              <span>c1 88 4d 3b a0 7e</span>
              <span>09 f6 de 31 55 b2</span>
            </div>
          </div>
          <div className="security-copy">
            <LockKeyIcon size={22} weight="fill" />
            <div>
              <strong>Zero-knowledge by design</strong>
              <p>Encryption happens in this browser. Share keys live after the # and never reach the server.</p>
            </div>
          </div>
        </LayerCard>
      </section>
    </main>
  );
}

function LockedVault({
  busy,
  error,
  onUnlock,
  onLogout,
}: {
  busy: boolean;
  error: string | null;
  onUnlock: () => void;
  onLogout: () => void;
}) {
  return (
    <main className="center-page">
      <LayerCard className="auth-card">
        <div className="auth-icon"><LockKeyIcon size={34} weight="duotone" /></div>
        <h1>Vault locked</h1>
        <p>Your session is active, but your encryption key only exists after passkey verification.</p>
        {error && <Banner variant="error" description={error} />}
        <Button variant="primary" size="lg" icon={FingerprintIcon} loading={busy} onClick={onUnlock}>
          Unlock with passkey
        </Button>
        <Button variant="ghost" onClick={onLogout}>Sign out instead</Button>
      </LayerCard>
    </main>
  );
}

function Dashboard({
  accountKey,
  config,
  me,
  onLogout,
  onRefreshMe,
}: {
  accountKey: CryptoKey;
  config: AppConfig;
  me: MeResponse;
  onLogout: () => Promise<void>;
  onRefreshMe: () => Promise<void>;
}) {
  const [pastes, setPastes] = useState<UnlockedPaste[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [addingPasskey, setAddingPasskey] = useState(false);

  const loadPastes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<{ pastes: StoredPaste[] }>("/api/pastes");
      const unlocked = await Promise.all(
        result.pastes.map(async (stored) => ({ stored, ...(await decryptOwnedPaste(accountKey, stored)) })),
      );
      setPastes(unlocked);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [accountKey]);

  useEffect(() => {
    loadPastes();
  }, [loadPastes]);

  async function deletePaste(paste: UnlockedPaste) {
    if (!window.confirm(`Delete “${paste.payload.title || "Untitled paste"}”? This cannot be undone.`)) return;
    try {
      await api<void>(`/api/pastes/${paste.stored.id}`, { method: "DELETE" });
      setPastes((current) => current.filter((item) => item.stored.id !== paste.stored.id));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function sharePaste(paste: UnlockedPaste) {
    setError(null);
    try {
      const share = await createShareEnvelope(paste.stored.id, paste.pasteKey, paste.stored.expiresAt);
      await api(`/api/pastes/${paste.stored.id}/shares`, {
        method: "POST",
        ...jsonBody(share.write),
      });
      const url = `${window.location.origin}/s/${share.write.id}#${share.secret}`;
      await navigator.clipboard.writeText(url);
      setNotice("Encrypted share link copied. The key never touched the server.");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function addPasskey() {
    setAddingPasskey(true);
    setError(null);
    try {
      await registerPasskey(accountKey);
      await onRefreshMe();
      setNotice("Backup passkey added.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setAddingPasskey(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <Brand />
        <div className="header-actions">
          <span className="encrypted-state"><CheckIcon weight="bold" /> Vault unlocked</span>
          <Button size="sm" icon={KeyIcon} loading={addingPasskey} onClick={addPasskey}>Add passkey</Button>
          <GitHubLink />
          <Button size="sm" variant="ghost" icon={SignOutIcon} onClick={onLogout}>Sign out</Button>
        </div>
      </header>

      <section className="dashboard-head">
        <div>
          <p className="eyebrow">Your encrypted vault</p>
          <h1>Pastes</h1>
          <p>{pastes.length} encrypted {pastes.length === 1 ? "paste" : "pastes"} · {me.passkeys?.length ?? 1} passkey</p>
        </div>
        <Button variant="primary" size="lg" icon={PlusIcon} onClick={() => setShowComposer((value) => !value)}>
          New paste
        </Button>
      </section>

      {error && <Banner className="dashboard-banner" variant="error" title="Something went wrong" description={error} />}
      {notice && (
        <Banner
          className="dashboard-banner"
          title="Done"
          description={notice}
          action={<Button size="sm" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>}
        />
      )}

      {showComposer && (
        <PasteComposer
          accountKey={accountKey}
          limits={config.limits}
          onCreated={async () => {
            setShowComposer(false);
            setNotice("Paste encrypted and saved.");
            await loadPastes();
          }}
          onCancel={() => setShowComposer(false)}
        />
      )}

      <section className="paste-list" aria-live="polite">
        {loading ? (
          <CenteredStatus label="Decrypting your pastes…" compact />
        ) : pastes.length === 0 ? (
          <LayerCard className="empty-card">
            <LockKeyIcon size={32} weight="duotone" />
            <h2>No pastes yet</h2>
            <p>Create one. We’ll encrypt the title and content before anything leaves your browser.</p>
            <Button variant="primary" icon={PlusIcon} onClick={() => setShowComposer(true)}>Create your first paste</Button>
          </LayerCard>
        ) : (
          pastes.map((paste) => (
            <PasteCard key={paste.stored.id} paste={paste} onShare={() => sharePaste(paste)} onDelete={() => deletePaste(paste)} />
          ))
        )}
      </section>
    </main>
  );
}

function PasteComposer({
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

function PasteCard({ paste, onShare, onDelete }: { paste: UnlockedPaste; onShare: () => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [shares, setShares] = useState<{ id: string; createdAt: number; expiresAt: number | null }[] | null>(null);
  const [attachments, setAttachments] = useState<UnlockedAttachment[] | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const preview = paste.payload.content.split("\n").slice(0, 4).join("\n");

  async function toggleShares() {
    if (shares) return setShares(null);
    setShareError(null);
    try {
      const result = await api<{ shares: { id: string; createdAt: number; expiresAt: number | null }[] }>(
        `/api/pastes/${paste.stored.id}/shares`,
      );
      setShares(result.shares);
    } catch (cause) {
      setShareError(messageOf(cause));
    }
  }

  async function revokeShare(id: string) {
    try {
      await api<void>(`/api/pastes/${paste.stored.id}/shares/${id}`, { method: "DELETE" });
      setShares((current) => current?.filter((share) => share.id !== id) ?? []);
    } catch (cause) {
      setShareError(messageOf(cause));
    }
  }

  async function toggleFiles() {
    if (attachments) return setAttachments(null);
    setShareError(null);
    try {
      const result = await api<{ attachments: StoredAttachment[] }>(`/api/pastes/${paste.stored.id}/files`);
      setAttachments(
        await Promise.all(
          result.attachments.map(async (stored) => ({ stored, ...(await decryptAttachmentMetadata(paste.pasteKey, stored)) })),
        ),
      );
    } catch (cause) {
      setShareError(messageOf(cause));
    }
  }

  async function removeFile(attachment: UnlockedAttachment) {
    try {
      await api<void>(`/api/pastes/${paste.stored.id}/files/${attachment.stored.id}`, { method: "DELETE" });
      setAttachments((current) => current?.filter((item) => item.stored.id !== attachment.stored.id) ?? []);
    } catch (cause) {
      setShareError(messageOf(cause));
    }
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
      {shareError && <div className="share-error">{shareError}</div>}
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
        <div className="attachment-list">
          <strong>Encrypted attachments</strong>
          {attachments.length === 0 ? <p>No files attached.</p> : attachments.map((attachment) => (
            <div className="attachment-row" key={attachment.stored.id}>
              <FileIcon />
              <span>{attachment.metadata.name}</span>
              <small>{formatBytes(attachment.metadata.size)}</small>
              <Button
                size="xs"
                icon={DownloadSimpleIcon}
                onClick={() => downloadAttachment(
                  `/api/pastes/${paste.stored.id}/files/${attachment.stored.id}/content`,
                  attachment,
                ).catch((cause) => setShareError(messageOf(cause)))}
              >
                Download
              </Button>
              <Button size="xs" variant="secondary-destructive" onClick={() => removeFile(attachment)}>Delete</Button>
            </div>
          ))}
        </div>
      )}
      <button className="paste-preview" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <pre>{expanded ? paste.payload.content : preview}</pre>
        {!expanded && paste.payload.content.split("\n").length > 4 && <span>Show all</span>}
      </button>
    </LayerCard>
  );
}

function SharedPastePage({ shareId }: { shareId: string }) {
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

function GitHubLink() {
  return (
    <LinkButton
      href="https://github.com/angristan/pastekey"
      external
      size="sm"
      variant="ghost"
      icon={GithubLogoIcon}
    >
      GitHub
    </LinkButton>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark"><KeyIcon size={20} weight="fill" /></span>
      <span>pastekey</span>
    </div>
  );
}

function CenteredStatus({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={compact ? "status compact" : "status"}><span className="spinner" />{label}</div>;
}

function shareIdFromPath() {
  const match = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]{20,64})$/);
  return match?.[1] ?? null;
}

function expiryTimestamp(expiry: Expiry) {
  const durations: Record<Exclude<Expiry, "never">, number> = {
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
  };
  return expiry === "never" ? null : Date.now() + durations[expiry];
}

async function downloadAttachment(endpoint: string, attachment: UnlockedAttachment) {
  const response = await fetch(endpoint);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Download failed (${response.status})`);
  }
  const plaintext = await decryptAttachmentContent(
    attachment.fileKey,
    attachment.stored,
    await response.arrayBuffer(),
  );
  const url = URL.createObjectURL(new Blob([plaintext], { type: attachment.metadata.type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.metadata.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function formatExpiry(timestamp: number | null) {
  if (!timestamp) return "never expires";
  const relative = Math.max(1, Math.round((timestamp - Date.now()) / (60 * 60 * 1000)));
  return relative < 24 ? `expires in ${relative}h` : `expires in ${Math.round(relative / 24)}d`;
}

function messageOf(cause: unknown) {
  if (cause instanceof DOMException && cause.name === "NotAllowedError") return "Passkey verification was canceled or timed out.";
  return cause instanceof Error ? cause.message : "An unexpected error occurred.";
}
