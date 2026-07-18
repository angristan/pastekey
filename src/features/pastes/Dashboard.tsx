import { Banner, Button, LayerCard } from "@cloudflare/kumo";
import { CheckIcon, KeyIcon, LockKeyIcon, PlusIcon, SignOutIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { Brand, CenteredStatus, GitHubLink } from "../../components/Brand";
import { api, jsonBody } from "../../lib/api";
import { createShareEnvelope, decryptOwnedPaste } from "../../lib/crypto";
import { messageOf } from "../../lib/format";
import { registerPasskey } from "../../lib/passkeys";
import type { AppConfig, MeResponse, StoredPaste } from "../../lib/types";
import { PasteCard } from "./PasteCard";
import { PasteComposer } from "./PasteComposer";
import type { UnlockedPaste } from "./types";

export function Dashboard({
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
