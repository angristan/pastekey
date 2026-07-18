import { Badge, Banner, Button, LayerCard } from "@cloudflare/kumo";
import { FingerprintIcon, KeyIcon, LockKeyIcon, PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { Brand, GitHubLink } from "../../components/Brand";
import type { AppConfig } from "../../lib/types";
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
