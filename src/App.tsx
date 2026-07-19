import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { CenteredStatus } from "./components/CenteredStatus";
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
  const mounted = useRef(true);
  const startupController = useRef<AbortController | null>(null);
  const authController = useRef<AbortController | null>(null);

  const refreshMe = useCallback(async (signal?: AbortSignal) => {
    const [{ requestApi }, { MeResponse: MeResponseSchema }] = await Promise.all([
      import("./effect/runtime"),
      import("../shared/schema/auth"),
    ]);
    const response = await requestApi("/api/auth/me", MeResponseSchema, { signal });
    if (!signal?.aborted && mounted.current) setMe(response);
  }, []);

  const loadStartup = useCallback(async () => {
    startupController.current?.abort();
    const controller = new AbortController();
    startupController.current = controller;
    if (mounted.current) setError(null);
    try {
      const [, loadedConfig] = await Promise.all([
        refreshMe(controller.signal),
        appConfig(controller.signal),
      ]);
      if (!controller.signal.aborted && mounted.current) setConfig(loadedConfig);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) setError(messageOf(cause));
    } finally {
      if (startupController.current === controller) startupController.current = null;
    }
  }, [refreshMe]);

  useEffect(() => {
    mounted.current = true;
    void loadStartup();
    return () => {
      mounted.current = false;
      startupController.current?.abort();
      authController.current?.abort();
    };
  }, [loadStartup]);

  async function authenticate(mode: "register" | "unlock", turnstileToken?: string) {
    authController.current?.abort();
    const controller = new AbortController();
    authController.current = controller;
    setBusy(mode);
    setError(null);
    try {
      const { registerPasskey, unlockWithPasskey } = await import("./lib/passkeys");
      const options = { signal: controller.signal };
      const result = mode === "register"
        ? await registerPasskey(undefined, turnstileToken, options)
        : await unlockWithPasskey(options);
      if (controller.signal.aborted || !mounted.current) return;
      setAccountKey(result.accountKey);
      await refreshMe(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) setError(messageOf(cause));
    } finally {
      if (authController.current === controller) authController.current = null;
      if (!controller.signal.aborted && mounted.current) setBusy(null);
    }
  }

  async function logout() {
    const [{ requestApi }, { NoContentResponse }] = await Promise.all([
      import("./effect/runtime"),
      import("../shared/schema/api"),
    ]);
    await requestApi("/api/auth/logout", NoContentResponse, { method: "POST" });
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
