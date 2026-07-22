import type { Context } from "hono";

import type {
  AccountDeletionPayload as AccountDeletionPayloadSchema,
  DeletionMessage as DeletionMessageSchema,
} from "../shared/schema/deletions";

export type AccountDeletionPayload = typeof AccountDeletionPayloadSchema.Encoded;
export type DeletionMessage = typeof DeletionMessageSchema.Encoded;

type WidenConfiguredValues<T> = {
  readonly [Key in keyof T]: T[Key] extends string ? string : T[Key];
};

export type FlagshipBinding = Pick<Env["FLAGS"], "getBooleanValue">;

export type Bindings = WidenConfiguredValues<Omit<Env, "DELETION_QUEUE">> & {
  readonly DELETION_QUEUE: Queue<DeletionMessage>;
};

export type Variables = {
  userId: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export type AppContext = Context<AppEnv>;

export type DeletionJobRow = {
  id: string;
  owner_id: string;
  object_key: string;
  ciphertext_size: number;
  created_at: number;
  queued_at: number | null;
  failure_cycles: number;
  next_attempt_at: number;
  last_failed_at: number | null;
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
