import { LinkButton } from "@cloudflare/kumo/components/button";
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
