import type { AppConfig } from "../../shared/protocol/config";

let configPromise: Promise<AppConfig> | undefined;

const loadConfig = async () => {
  const [{ AppConfig: AppConfigSchema }, { requestApi }] = await Promise.all([
    import("../../shared/schema/config"),
    import("../effect/runtime"),
  ]);
  return requestApi("/api/config", AppConfigSchema);
};

export function appConfig(signal?: AbortSignal) {
  if (!configPromise) {
    // The request is shared across React hosts, so one caller must not abort it
    // for every other caller. Each caller can still cancel its own wait below.
    configPromise = loadConfig().catch((cause) => {
      configPromise = undefined;
      throw cause;
    });
  }
  const sharedConfig = configPromise;
  if (signal === undefined) return sharedConfig;
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<AppConfig>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    sharedConfig.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
