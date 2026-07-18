export function randomId(bytes = 16) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
