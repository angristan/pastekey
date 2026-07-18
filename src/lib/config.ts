import { api } from "./api";
import type { AppConfig } from "../../shared/protocol/config";

let configPromise: Promise<AppConfig> | undefined;

export function appConfig() {
  if (!configPromise) {
    configPromise = api<AppConfig>("/api/config").catch((cause) => {
      configPromise = undefined;
      throw cause;
    });
  }
  return configPromise;
}
