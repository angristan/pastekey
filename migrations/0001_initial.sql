PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  wrapped_account_key TEXT NOT NULL,
  wrapped_account_key_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX credentials_user_idx ON credentials(user_id);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'add-passkey', 'login')),
  user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_challenges_expiry_idx ON auth_challenges(expires_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE pastes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  content_iv TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  wrapped_key_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX pastes_owner_updated_idx ON pastes(owner_id, updated_at DESC);
CREATE INDEX pastes_expiry_idx ON pastes(expires_at);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  paste_id TEXT NOT NULL REFERENCES pastes(id) ON DELETE CASCADE,
  wrapped_key TEXT NOT NULL,
  wrapped_key_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX shares_paste_idx ON shares(paste_id);
CREATE INDEX shares_expiry_idx ON shares(expires_at);
