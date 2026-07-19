import { ManagedRuntime } from "effect";

import { ApiClientLive } from "./api";

/**
 * Shared browser runtime for Promise-based entry points. Dispose it when the
 * browser application is torn down so future scoped layers can release safely.
 */
export const browserRuntime = ManagedRuntime.make(ApiClientLive);
