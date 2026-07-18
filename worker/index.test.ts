import { describe, expect, it } from "vitest";

import worker from "./index";
import type { Bindings } from "./types";

const context = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

describe("Worker composition", () => {
  it("serves health through the composition root", async () => {
    const response = await worker.fetch(new Request("https://paste.test/api/health"), env(), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("serves direct share routes with generic noindex HTML", async () => {
    const response = await worker.fetch(
      new Request("https://paste.test/s/AAAAAAAAAAAAAAAAAAAA"),
      env(),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
    await expect(response.text()).resolves.toContain("<title>Pastekey");
  });

  it("exposes limits and the production Turnstile site key", async () => {
    const response = await worker.fetch(new Request("https://paste.test/api/config"), env(), context);
    await expect(response.json()).resolves.toEqual({
      limits: {
        maxFileBytes: 1024,
        maxFilesPerPaste: 2,
        maxPastesPerUser: 3,
        maxStorageBytes: 4096,
      },
      turnstileSiteKey: "site-key",
    });
  });

  it("hides the production widget in local development without its secret", async () => {
    const response = await worker.fetch(new Request("http://localhost:5173/api/config"), env(), context);
    const body = await response.json() as { turnstileSiteKey: string | null };
    expect(body.turnstileSiteKey).toBeNull();
  });
});

function env(): Bindings {
  return {
    ASSETS: {
      fetch: async () => new Response("<!doctype html><title>Pastekey — Private, encrypted sharing</title>", {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      }),
    } as unknown as Fetcher,
    MAX_FILE_BYTES: "1024",
    MAX_FILES_PER_PASTE: "2",
    MAX_PASTES_PER_USER: "3",
    MAX_STORAGE_BYTES: "4096",
    TURNSTILE_SITE_KEY: "site-key",
  } as Bindings;
}
