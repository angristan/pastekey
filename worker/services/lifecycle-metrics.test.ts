import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runWorkerEffect } from "../runtime";
import type { Bindings } from "../types";
import { recordLifecycleMetrics } from "./lifecycle-metrics";

const bindings = env as unknown as Bindings;
const ownerId = "metrics-owner-000000001";
const jobId = "metrics-job-00000000001";

describe("lifecycle metrics", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await bindings.DB.prepare("DELETE FROM deletion_jobs WHERE owner_id = ?").bind(ownerId).run();
  });

  it("records identifier-free backlog counts and age", async () => {
    const now = Date.now();
    await bindings.DB.prepare(
      `INSERT INTO deletion_jobs (
        id, owner_id, object_key, ciphertext_size, created_at, queued_at
      ) VALUES (?, ?, ?, 32, ?, NULL)`,
    ).bind(jobId, ownerId, `${ownerId}/${jobId}`, now - 2 * 60 * 60 * 1_000).run();
    const writeDataPoint = vi.fn();

    await runWorkerEffect(
      {
        ...bindings,
        EVENTS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
      },
      recordLifecycleMetrics(now),
    );

    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ["lifecycle_snapshot", "under_10", "1_to_6h"],
      doubles: [1, 2, 0, 0],
      indexes: ["lifecycle_snapshot"],
    });
    expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain(ownerId);
    expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain(jobId);
  });

  it("fails open when Analytics Engine is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeDataPoint = vi.fn(() => {
      throw new Error("Analytics Engine unavailable");
    });

    await expect(runWorkerEffect(
      {
        ...bindings,
        EVENTS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
      },
      recordLifecycleMetrics(),
    )).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "Lifecycle metrics unavailable",
      expect.objectContaining({ operation: "write" }),
    );
  });
});
