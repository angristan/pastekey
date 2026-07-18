export type WrappedKey = {
  ciphertext: string;
  iv: string;
};

export type PasskeySummary = {
  id: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
  deviceType: string;
};

export type MeResponse = {
  authenticated: boolean;
  userId?: string;
  passkeys?: PasskeySummary[];
};

export type AuthSuccess = {
  userId: string;
  credentialId: string;
  wrappedAccountKey: WrappedKey;
};
