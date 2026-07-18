import { LinkButton } from "@cloudflare/kumo";
import { GithubLogoIcon, KeyIcon } from "@phosphor-icons/react";

export function GitHubLink() {
  return (
    <LinkButton
      href="https://github.com/angristan/pastekey"
      external
      size="sm"
      variant="ghost"
      icon={GithubLogoIcon}
    >
      GitHub
    </LinkButton>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark"><KeyIcon size={20} weight="fill" /></span>
      <span>pastekey</span>
    </div>
  );
}

export function CenteredStatus({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={compact ? "status compact" : "status"}><span className="spinner" />{label}</div>;
}
