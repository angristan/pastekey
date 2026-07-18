CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  paste_id TEXT NOT NULL REFERENCES pastes(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  ciphertext_size INTEGER NOT NULL CHECK (ciphertext_size > 16),
  content_iv TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  wrapped_key_iv TEXT NOT NULL,
  metadata_ciphertext TEXT NOT NULL,
  metadata_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX attachments_paste_idx ON attachments(paste_id, created_at);
