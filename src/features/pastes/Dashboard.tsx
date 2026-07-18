import { Banner, Button, LayerCard } from "@cloudflare/kumo";
import { CheckIcon, KeyIcon, LockKeyIcon, PlusIcon, SignOutIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { Brand, CenteredStatus, GitHubLink } from "../../components/Brand";
import { api, jsonBody } from "../../lib/api";
import { createShareEnvelope, decryptOwnedPaste } from "../../lib/crypto";
import { messageOf } from "../../lib/format";
import { registerPasskey } from "../../lib/passkeys";
import { itemKindOf, type AppConfig, type ItemKind, type MeResponse, type StoredPaste } from "../../lib/types";
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
  const [composerKind, setComposerKind] = useState<ItemKind | null>(null);
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
    const noun = itemKindOf(paste.payload) === "files" ? "file item" : "paste";
    if (!window.confirm(`Delete ${noun} “${paste.payload.title || "Untitled"}”? This cannot be undone.`)) return;
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
          <h1>Pastes & files</h1>
          <p>{pastes.length} encrypted {pastes.length === 1 ? "item" : "items"} · {me.passkeys?.length ?? 1} passkey</p>
        </div>
        <div className="dashboard-create-actions">
          <Button
            size="lg"
            icon={UploadSimpleIcon}
            onClick={() => setComposerKind((current) => current === "files" ? null : "files")}
          >
            Upload files
          </Button>
          <Button
            variant="primary"
            size="lg"
            icon={PlusIcon}
            onClick={() => setComposerKind((current) => current === "paste" ? null : "paste")}
          >
            New paste
          </Button>
        </div>
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

      {composerKind && (
        <PasteComposer
          key={composerKind}
          accountKey={accountKey}
          kind={composerKind}
          limits={config.limits}
          onCreated={async () => {
            setComposerKind(null);
            setNotice(composerKind === "files" ? "Files encrypted and uploaded." : "Paste encrypted and saved.");
            await loadPastes();
          }}
          onCancel={() => setComposerKind(null)}
        />
      )}

      <section className="paste-list" aria-live="polite">
        {loading ? (
          <CenteredStatus label="Decrypting your items…" compact />
        ) : pastes.length === 0 ? (
          <LayerCard className="empty-card">
            <LockKeyIcon size={32} weight="duotone" />
            <h2>Your vault is empty</h2>
            <p>Create a paste or upload files. Everything is encrypted before it leaves your browser.</p>
            <div className="empty-actions">
              <Button icon={UploadSimpleIcon} onClick={() => setComposerKind("files")}>Upload files</Button>
              <Button variant="primary" icon={PlusIcon} onClick={() => setComposerKind("paste")}>Create a paste</Button>
            </div>
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
