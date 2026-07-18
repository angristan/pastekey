import type { Bindings } from "../types";

type LifecycleSnapshot = {
  deletionCount: number;
  oldestDeletionAt: number | null;
  expiredReservationCount: number;
  recoveryAccountCount: number;
};

export async function recordLifecycleMetrics(env: Bindings, now = Date.now()) {
  try {
    const snapshot = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM deletion_jobs) AS deletionCount,
        (SELECT MIN(created_at) FROM deletion_jobs) AS oldestDeletionAt,
        (SELECT COUNT(*) FROM upload_reservations WHERE expires_at <= ?) AS expiredReservationCount,
        (SELECT COUNT(*) FROM users
          WHERE deletion_requested_at IS NOT NULL AND deletion_next_recovery_at <= ?) AS recoveryAccountCount`,
    ).bind(now, now).first<LifecycleSnapshot>();
    if (!snapshot) return;

    const oldestAgeHours = snapshot.oldestDeletionAt === null
      ? 0
      : Math.max(0, (now - snapshot.oldestDeletionAt) / (60 * 60 * 1_000));
    env.EVENTS.writeDataPoint({
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
  } catch (error) {
    console.error("Lifecycle metrics unavailable", error);
  }
}

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
