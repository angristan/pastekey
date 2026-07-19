import { Effect, Schema } from "effect";

import { AnalyticsEngine } from "../platform/cloudflare";
import { D1 } from "../platform/d1";

const LifecycleSnapshot = Schema.Struct({
  deletionCount: Schema.Number,
  oldestDeletionAt: Schema.Union([Schema.Number, Schema.Null]),
  expiredReservationCount: Schema.Number,
  recoveryAccountCount: Schema.Number,
});

export const recordLifecycleMetrics = Effect.fn(
  "LifecycleMetrics.recordLifecycleMetrics",
)(function* (now = Date.now()) {
  const d1 = yield* D1;
  const events = yield* AnalyticsEngine;

  yield* Effect.gen(function* () {
    const snapshot = yield* d1.first(
      d1.bind(
        d1.prepare(
          `SELECT
        (SELECT COUNT(*) FROM deletion_jobs) AS deletionCount,
        (SELECT MIN(created_at) FROM deletion_jobs) AS oldestDeletionAt,
        (SELECT COUNT(*) FROM upload_reservations WHERE expires_at <= ?) AS expiredReservationCount,
        (SELECT COUNT(*) FROM users
          WHERE deletion_requested_at IS NOT NULL AND deletion_next_recovery_at <= ?) AS recoveryAccountCount`,
        ),
        now,
        now,
      ),
      LifecycleSnapshot,
    );
    if (snapshot === null) return;

    const oldestAgeHours = snapshot.oldestDeletionAt === null
      ? 0
      : Math.max(0, (now - snapshot.oldestDeletionAt) / (60 * 60 * 1_000));
    yield* events.write({
      blobs: [
        "lifecycle_snapshot",
        countBucket(snapshot.deletionCount),
        ageBucket(oldestAgeHours),
      ],
      doubles: [
        snapshot.deletionCount,
        Math.round(oldestAgeHours * 100) / 100,
        snapshot.expiredReservationCount,
        snapshot.recoveryAccountCount,
      ],
      indexes: ["lifecycle_snapshot"],
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        // Lifecycle telemetry is best-effort and must not affect scheduled cleanup.
        console.error("Lifecycle metrics unavailable", error);
      })
    ),
  );
});

function countBucket(count: number) {
  if (count === 0) return "empty";
  if (count < 10) return "under_10";
  if (count < 100) return "10_to_99";
  if (count < 1_000) return "100_to_999";
  return "1000_plus";
}

function ageBucket(hours: number) {
  if (hours === 0) return "none";
  if (hours < 1) return "under_1h";
  if (hours < 6) return "1_to_6h";
  if (hours < 24) return "6_to_24h";
  return "24h_plus";
}
