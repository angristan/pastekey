ALTER TABLE deletion_jobs ADD COLUMN failure_cycles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deletion_jobs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deletion_jobs ADD COLUMN last_failed_at INTEGER;

DROP INDEX deletion_jobs_pending_idx;
CREATE INDEX deletion_jobs_dispatch_idx ON deletion_jobs(queued_at, next_attempt_at, created_at);
