import { Layer, ManagedRuntime, Schema } from "effect";

import { ApiClient, ApiClientLive } from "./api";
import { BrowserCryptoLive } from "./crypto";
import { WebAuthnLive } from "./webauthn";

/**
 * Shared browser runtime for Promise-based entry points. Dispose it when the
 * browser application is torn down so future scoped layers can release safely.
 */
export const browserRuntime = ManagedRuntime.make(Layer.mergeAll(
  ApiClientLive,
  BrowserCryptoLive,
  WebAuthnLive,
));

export const requestApi = <S extends Schema.ConstraintDecoder<unknown>>(
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<S["Type"]> => browserRuntime.runPromise(
  ApiClient.use((client) => client.request(path, schema, init)),
);
