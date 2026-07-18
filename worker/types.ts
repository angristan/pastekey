import type { Context } from "hono";

export type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  EVENTS: AnalyticsEngineDataset;
  DELETION_QUEUE: Queue<DeletionMessage>;
  ACCOUNT_DELETION: Workflow<AccountDeletionPayload>;
  AUTH_RATE_LIMITER: RateLimit;
  WRITE_RATE_LIMITER: RateLimit;
  MAX_FILE_BYTES?: string;
  MAX_FILES_PER_PASTE?: string;
  MAX_PASTES_PER_USER?: string;
  MAX_STORAGE_BYTES?: string;
  ORIGIN?: string;
  RP_ID?: string;
  RP_NAME?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
};

export type Variables = {
  userId: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export type AppContext = Context<AppEnv>;

export type DeletionMessage = {
  jobId: string;
};

export type AccountDeletionPayload = {
  userId: string;
};

export type DeletionJobRow = {
  id: string;
  owner_id: string;
  object_key: string;
  ciphertext_size: number;
  created_at: number;
  queued_at: number | null;
};

export type ChallengeRow = {
  id: string;
  challenge: string;
  kind: "register" | "add-passkey" | "login";
  user_id: string | null;
  expires_at: number;
};

export type CredentialRow = {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string;
  device_type: string;
  backed_up: number;
  wrapped_account_key: string;
  wrapped_account_key_iv: string;
};

export type PasteWrite = {
  id: string;
  ciphertext: string;
  contentIv: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  expiresAt?: number | null;
};

export type ShareWrite = {
  id: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  expiresAt?: number | null;
};
