ALTER TABLE users ADD COLUMN deletion_recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN deletion_next_recovery_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX users_deletion_recovery_idx
ON users(deletion_requested_at, deletion_next_recovery_at);
