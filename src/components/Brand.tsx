import { GithubLogoIcon, KeyIcon } from "@phosphor-icons/react";

export function GitHubLink() {
  return (
    <a
      className="github-link"
      href="https://github.com/angristan/pastekey"
      rel="noreferrer"
      target="_blank"
    >
      <GithubLogoIcon aria-hidden />
      <span>GitHub</span>
    </a>
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
