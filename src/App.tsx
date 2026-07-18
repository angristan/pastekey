import {
  Badge,
  Banner,
  Button,
  Input,
  LayerCard,
  Select,
  Textarea,
} from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  FingerprintIcon,
  KeyIcon,
  LockKeyIcon,
  PlusIcon,
  ShareNetworkIcon,
  SignOutIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { api, jsonBody } from "./lib/api";
import {
  createShareEnvelope,
  decryptOwnedPaste,
  decryptSharedPaste,
  encryptNewPaste,
} from "./lib/crypto";
import { registerPasskey, unlockWithPasskey } from "./lib/passkeys";
import type { MeResponse, PastePayload, StoredPaste, StoredShare } from "./lib/types";

type UnlockedPaste = {
  stored: StoredPaste;
  payload: PastePayload;
  pasteKey: CryptoKey;
};

type Expiry = "hour" | "day" | "week" | "never";

export default function App() {
  const shareId = shareIdFromPath();
  if (shareId) return <SharedPastePage shareId={shareId} />;
  return <VaultApp />;
}

function VaultApp() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountKey, setAccountKey] = useState<CryptoKey | null>(null);
  const [busy, setBusy] = useState<"register" | "unlock" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    setMe(await api<MeResponse>("/api/auth/me"));
  }, []);

  useEffect(() => {
    refreshMe().catch((cause) => setError(messageOf(cause)));
  }, [refreshMe]);

  async function authenticate(mode: "register" | "unlock") {
    setBusy(mode);
    setError(null);
    try {
      const result = mode === "register" ? await registerPasskey() : await unlockWithPasskey();
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

  if (!me) {
    return <CenteredStatus label="Opening Pastekey…" />;
  }

  if (!me.authenticated) {
    return (
      <Landing
        busy={busy}
        error={error}
        onRegister={() => authenticate("register")}
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

  return <Dashboard accountKey={accountKey} me={me} onLogout={logout} onRefreshMe={refreshMe} />;
}

function Landing({
  busy,
  error,
  onRegister,
  onUnlock,
}: {
  busy: "register" | "unlock" | null;
  error: string | null;
  onRegister: () => void;
  onUnlock: () => void;
}) {
  return (
    <main className="landing shell">
      <header className="brandbar">
        <Brand />
        <Badge>Preview</Badge>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">No passwords. No plaintext.</p>
          <h1>Paste something.<br />Keep the key.</h1>
          <p className="hero-description">
            An end-to-end encrypted pastebin unlocked by your passkey. Cloudflare stores ciphertext—not your words.
          </p>
          <div className="hero-actions">
            <Button variant="primary" size="lg" icon={PlusIcon} loading={busy === "register"} onClick={onRegister}>
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
  me,
  onLogout,
  onRefreshMe,
}: {
  accountKey: CryptoKey;
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
  onCreated,
  onCancel,
}: {
  accountKey: CryptoKey;
  onCreated: () => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [language, setLanguage] = useState("text");
  const [expiry, setExpiry] = useState<Expiry>("week");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim()) return setError("Paste content cannot be empty.");
    setSaving(true);
    setError(null);
    try {
      const encrypted = await encryptNewPaste(
        accountKey,
        { title: title.trim() || "Untitled paste", content, language },
        expiryTimestamp(expiry),
      );
      await api("/api/pastes", { method: "POST", ...jsonBody(encrypted.write) });
      await onCreated();
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
        <div className="composer-actions">
          <span><LockKeyIcon /> Encrypted with a new per-paste key</span>
          <div>
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="primary" loading={saving}>Encrypt & save</Button>
          </div>
        </div>
      </form>
    </LayerCard>
  );
}

function PasteCard({ paste, onShare, onDelete }: { paste: UnlockedPaste; onShare: () => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [shares, setShares] = useState<{ id: string; createdAt: number; expiresAt: number | null }[] | null>(null);
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
        setPayload(await decryptSharedPaste(stored, secret));
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
        <span className="encrypted-state"><LockKeyIcon weight="fill" /> Decrypted locally</span>
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
          <footer className="shared-footer">
            <span><KeyIcon /> End-to-end encrypted. Pastekey can’t read this paste.</span>
            <a href="/" className="text-link">Create your own <ArrowSquareOutIcon /></a>
          </footer>
        </LayerCard>
      )}
    </main>
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
