import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { CenteredStatus } from "./components/CenteredStatus";
import { api } from "./lib/api";
import { messageOf } from "./lib/format";
import type { AppConfig, MeResponse } from "./lib/types";

const Landing = lazy(() => import("./features/auth/Landing").then((module) => ({ default: module.Landing })));
const LockedVault = lazy(() => import("./features/auth/LockedVault").then((module) => ({ default: module.LockedVault })));
const Dashboard = lazy(() => import("./features/pastes/Dashboard").then((module) => ({ default: module.Dashboard })));
const SharedPastePage = lazy(() => import("./features/sharing/SharedPastePage").then((module) => ({ default: module.SharedPastePage })));

export default function App() {
  const shareId = shareIdFromPath();
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

  if (!me || !config) return <CenteredStatus label="Opening Pastekey…" />;

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

function shareIdFromPath() {
  const match = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]{20,64})$/);
  return match?.[1] ?? null;
}
