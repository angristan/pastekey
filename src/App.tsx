import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { CenteredStatus } from "./components/CenteredStatus";
import { api } from "./lib/api";
import { appConfig } from "./lib/config";
import { messageOf } from "./lib/format";
import { shareIdFromPath } from "./lib/routes";
import type { MeResponse } from "../shared/protocol/auth";
import type { AppConfig } from "../shared/protocol/config";

const Landing = lazy(() => import("./features/auth/Landing").then((module) => ({ default: module.Landing })));
const LockedVault = lazy(() => import("./features/auth/LockedVault").then((module) => ({ default: module.LockedVault })));
const Dashboard = lazy(() => import("./features/pastes/Dashboard").then((module) => ({ default: module.Dashboard })));
const SharedPastePage = lazy(() => import("./features/sharing/SharedPastePage").then((module) => ({ default: module.SharedPastePage })));

export default function App() {
  const shareId = shareIdFromPath(window.location.pathname);
  return (
    <Suspense fallback={<CenteredStatus label="Opening Pastekey…" />}>
      {shareId ? <SharedPastePage shareId={shareId} /> : <VaultApp />}
    </Suspense>
  );
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

  const loadStartup = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([
        refreshMe(),
        appConfig().then(setConfig),
      ]);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [refreshMe]);

  useEffect(() => {
    void loadStartup();
  }, [loadStartup]);

  async function authenticate(mode: "register" | "unlock", turnstileToken?: string) {
    setBusy(mode);
    setError(null);
    try {
      const { registerPasskey, unlockWithPasskey } = await import("./lib/passkeys");
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

  function accountDeleted() {
    setAccountKey(null);
    setMe({ authenticated: false });
  }

  if (!me || !config) {
    if (error) {
      return (
        <main className="center-page">
          <div className="startup-error" role="alert">
            <h1>Pastekey could not open</h1>
            <p>{error}</p>
            <button type="button" onClick={() => void loadStartup()}>Retry</button>
          </div>
        </main>
      );
    }
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

  return (
    <Dashboard
      accountKey={accountKey}
      config={config}
      me={me}
      onAccountDeleted={accountDeleted}
      onLogout={logout}
      onRefreshMe={refreshMe}
    />
  );
}
