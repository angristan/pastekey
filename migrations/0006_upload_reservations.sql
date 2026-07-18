-- Reservations deliberately survive user/paste cascades until their possible R2 object is cleaned.
CREATE TABLE upload_reservations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  paste_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  ciphertext_size INTEGER NOT NULL CHECK (ciphertext_size > 16),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX upload_reservations_owner_idx ON upload_reservations(owner_id, created_at);
CREATE INDEX upload_reservations_paste_idx ON upload_reservations(paste_id, created_at);
CREATE INDEX upload_reservations_expiry_idx ON upload_reservations(expires_at);
