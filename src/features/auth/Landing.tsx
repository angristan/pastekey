import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { FingerprintIcon, KeyIcon, LockKeyIcon, PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { Brand, GitHubLink } from "../../components/Brand";
import type { AppConfig } from "../../../shared/protocol/config";
import { Turnstile } from "./Turnstile";

export function Landing({
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
          <GitHubLink />
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Private sharing. No passwords.</p>
          <h1>Share anything.<br />Keep the key.</h1>
          <p className="hero-description">
            Paste text or upload files. Everything is encrypted in your browser and unlocked with your passkey—the server only stores ciphertext.
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
              Unlock your vault
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
              <strong>Encrypted before it leaves</strong>
              <p>Your browser encrypts everything. Share keys stay in the link fragment and never reach the server.</p>
            </div>
          </div>
        </LayerCard>
      </section>
    </main>
  );
}
