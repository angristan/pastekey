export type ShareSummary = {
  id: string;
  createdAt: number;
  expiresAt: number | null;
};

export type GeneratedShare = {
  shareId: string;
  url: string;
  copied: boolean;
};

export function mergeShares(...groups: ShareSummary[][]) {
  const merged = new Map<string, ShareSummary>();
  for (const share of groups.flat()) merged.set(share.id, share);
  return [...merged.values()];
}
