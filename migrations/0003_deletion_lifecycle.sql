ALTER TABLE users ADD COLUMN deletion_requested_at INTEGER;
ALTER TABLE users ADD COLUMN deletion_workflow_id TEXT;

CREATE INDEX users_deletion_requested_idx ON users(deletion_requested_at);

-- owner_id deliberately has no foreign key: queued R2 cleanup must survive account cascades.
CREATE TABLE deletion_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  ciphertext_size INTEGER NOT NULL CHECK (ciphertext_size > 16),
  created_at INTEGER NOT NULL,
  queued_at INTEGER
);

CREATE INDEX deletion_jobs_pending_idx ON deletion_jobs(queued_at, created_at);
CREATE INDEX deletion_jobs_owner_idx ON deletion_jobs(owner_id);
