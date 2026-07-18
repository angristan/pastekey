import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import {
  CheckIcon,
  FileTextIcon,
  KeyIcon,
  LockKeyIcon,
  PlusIcon,
  SignOutIcon,
  TrashIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { Brand, GitHubLink } from "../../components/Brand";
import { CenteredStatus } from "../../components/CenteredStatus";
import { api, jsonBody } from "../../lib/api";
import { createShareEnvelope, decryptOwnedPaste } from "../../lib/crypto";
import { messageOf } from "../../lib/format";
import { itemKindOf, type AppConfig, type ItemKind, type MeResponse, type StoredPaste } from "../../lib/types";
import { PasteCard } from "./PasteCard";
import type { UnlockedPaste } from "./types";

const PasteComposer = lazy(() => import("./PasteComposer").then((module) => ({ default: module.PasteComposer })));

export function Dashboard({
  accountKey,
  config,
  me,
  onAccountDeleted,
  onLogout,
  onRefreshMe,
}: {
  accountKey: CryptoKey;
  config: AppConfig;
  me: MeResponse;
  onAccountDeleted: () => void;
  onLogout: () => Promise<void>;
  onRefreshMe: () => Promise<void>;
}) {
  const [pastes, setPastes] = useState<UnlockedPaste[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creator, setCreator] = useState<ItemKind | "choose" | null>(null);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

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
    const noun = itemKindOf(paste.payload) === "files" ? "file drop" : "paste";
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
    const share = await createShareEnvelope(paste.stored.id, paste.pasteKey, paste.stored.expiresAt);
    const created = await api<{ id: string; createdAt: number }>(`/api/pastes/${paste.stored.id}/shares`, {
      method: "POST",
      ...jsonBody(share.write),
    });
    const url = `${window.location.origin}/s/${share.write.id}#${share.secret}`;
    setNotice("Encrypted link created. Copy it from the open link panel before leaving this page.");
    return {
      share: { id: created.id, createdAt: created.createdAt, expiresAt: share.write.expiresAt },
      url,
    };
  }

  async function deleteAccount() {
    if (!window.confirm("Permanently delete this account, every encrypted item, every file, and every share?")) return;
    if (window.prompt('Type "DELETE" to confirm. This cannot be undone.') !== "DELETE") return;

    setDeletingAccount(true);
    setError(null);
    try {
      const { unlockWithPasskey } = await import("../../lib/passkeys");
      const verified = await unlockWithPasskey();
      if (verified.auth.userId !== me.userId) {
        throw new Error("The selected passkey belongs to another account");
      }
      await api<{ status: "deleting" }>("/api/account", { method: "DELETE" });
      window.alert("Account deletion started. Access has been revoked and encrypted storage is being removed.");
      onAccountDeleted();
    } catch (cause) {
      setError(messageOf(cause));
      setDeletingAccount(false);
    }
  }

  async function addPasskey() {
    setAddingPasskey(true);
    setError(null);
    try {
      const { registerPasskey } = await import("../../lib/passkeys");
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
          <Button size="sm" variant="ghost" icon={SignOutIcon} disabled={creator !== null} onClick={onLogout}>Sign out</Button>
        </div>
      </header>

      <section className="dashboard-head">
        <div>
          <p className="eyebrow">Your encrypted vault</p>
          <h1>Vault</h1>
          <p>{pastes.length} encrypted {pastes.length === 1 ? "item" : "items"} · {me.passkeys?.length ?? 1} passkey</p>
        </div>
        <Button
          variant="primary"
          size="lg"
          icon={PlusIcon}
          disabled={creator !== null}
          onClick={() => setCreator("choose")}
        >
          Create
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

      {creator === "choose" && (
        <LayerCard className="create-picker">
          <div className="create-picker-heading">
            <div>
              <h2>Create something encrypted</h2>
              <p>Choose what you want to share. You can change your mind before saving.</p>
            </div>
            <Button variant="ghost" onClick={() => setCreator(null)}>Cancel</Button>
          </div>
          <div className="create-choice-grid">
            <button type="button" onClick={() => setCreator("paste")}>
              <FileTextIcon size={28} weight="duotone" />
              <strong>Text paste</strong>
              <span>Share text or code, with optional file attachments.</span>
            </button>
            <button type="button" onClick={() => setCreator("files")}>
              <UploadSimpleIcon size={28} weight="duotone" />
              <strong>File drop</strong>
              <span>Share one or more files without creating a paste.</span>
            </button>
          </div>
        </LayerCard>
      )}

      {(creator === "paste" || creator === "files") && (
        <Suspense fallback={<CenteredStatus label="Opening encrypted composer…" compact />}>
          <PasteComposer
            key={creator}
            accountKey={accountKey}
            kind={creator}
            limits={config.limits}
            onCreated={async () => {
              setCreator(null);
              setNotice(creator === "files" ? "File drop encrypted and uploaded." : "Paste encrypted and saved.");
              await loadPastes();
            }}
            onCancel={() => setCreator("choose")}
          />
        </Suspense>
      )}

      <section className="paste-list" aria-live="polite">
        {loading ? (
          <CenteredStatus label="Decrypting your items…" compact />
        ) : pastes.length === 0 ? (
          creator === null ? (
            <LayerCard className="empty-card">
              <LockKeyIcon size={32} weight="duotone" />
              <h2>Your vault is empty</h2>
              <p>Create a text paste or file drop. Everything is encrypted before it leaves your browser.</p>
              <Button variant="primary" icon={PlusIcon} onClick={() => setCreator("choose")}>Create your first item</Button>
            </LayerCard>
          ) : null
        ) : (
          pastes.map((paste) => (
            <PasteCard key={paste.stored.id} paste={paste} onShare={() => sharePaste(paste)} onDelete={() => deletePaste(paste)} />
          ))
        )}
      </section>

      <section className="account-management" aria-label="Account management">
        <div>
          <strong>Delete account</strong>
          <span>Permanently revoke access and remove all encrypted data.</span>
        </div>
        <Button
          className="delete-account-button"
          size="sm"
          variant="ghost"
          icon={TrashIcon}
          loading={deletingAccount}
          disabled={creator !== null}
          onClick={deleteAccount}
        >
          Delete account
        </Button>
      </section>
    </main>
  );
}
