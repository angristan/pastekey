import "@cloudflare/kumo/styles/standalone";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { FingerprintIcon, LockKeyIcon } from "@phosphor-icons/react";

export function LockedVault({
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
