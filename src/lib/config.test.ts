import { afterEach, describe, expect, it, vi } from "vitest";

import { appConfig } from "./config";
import type { AppConfig } from "./types";

const config: AppConfig = {
  limits: {
    maxFileBytes: 1024,
    maxFilesPerPaste: 2,
    maxPastesPerUser: 3,
    maxStorageBytes: 4096,
  },
  turnstileSiteKey: null,
};

describe("runtime configuration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries a failed request while sharing the next in-flight request", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveResponse = resolve; }));

    await expect(appConfig()).rejects.toThrow("temporary failure");
    const first = appConfig();
    const second = appConfig();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveResponse(Response.json(config));
    await expect(Promise.all([first, second])).resolves.toEqual([config, config]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
