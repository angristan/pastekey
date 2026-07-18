const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]{20,64})$/;

export function shareIdFromPath(pathname: string) {
  return pathname.match(SHARE_PATH)?.[1] ?? null;
}

export function shareSecretFromHash(hash: string) {
  return hash.startsWith("#") && hash.length > 1 ? hash.slice(1) : "";
}
