import { AppConfig } from "../../shared/schema/config";
import { requestApi } from "../effect/runtime";

let configPromise: Promise<AppConfig> | undefined;

export function appConfig() {
  if (!configPromise) {
    configPromise = requestApi("/api/config", AppConfig).catch((cause) => {
      configPromise = undefined;
      throw cause;
    });
  }
  return configPromise;
}
