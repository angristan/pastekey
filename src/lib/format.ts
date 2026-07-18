export type Expiry = "hour" | "day" | "week" | "never";

export function expiryTimestamp(expiry: Expiry) {
  const durations: Record<Exclude<Expiry, "never">, number> = {
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
  };
  return expiry === "never" ? null : Date.now() + durations[expiry];
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

export function formatExpiry(timestamp: number | null) {
  if (!timestamp) return "never expires";
  const relative = Math.max(1, Math.round((timestamp - Date.now()) / (60 * 60 * 1000)));
  return relative < 24 ? `expires in ${relative}h` : `expires in ${Math.round(relative / 24)}d`;
}

export function messageOf(cause: unknown) {
  if (cause instanceof DOMException && cause.name === "NotAllowedError") {
    return "Passkey verification was canceled or timed out.";
  }
  return cause instanceof Error ? cause.message : "An unexpected error occurred.";
}
