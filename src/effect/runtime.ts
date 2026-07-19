import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import { ApiClient, ApiClientLive } from "./api";
import type { BrowserCrypto } from "./crypto";
import type { WebAuthn } from "./webauthn";

const apiRuntime = ManagedRuntime.make(ApiClientLive);

type BrowserServices = ApiClient | BrowserCrypto | WebAuthn;

const makeBrowserRuntime = async () => {
  const [{ BrowserCryptoLive }, { WebAuthnLive }] = await Promise.all([
    import("./crypto"),
    import("./webauthn"),
  ]);
  return ManagedRuntime.make(Layer.mergeAll(ApiClientLive, BrowserCryptoLive, WebAuthnLive));
};

let browserRuntimePromise: ReturnType<typeof makeBrowserRuntime> | undefined;

const runBrowserPromise = <A, E>(
  effect: Effect.Effect<A, E, BrowserServices>,
  options?: Effect.RunOptions,
): Promise<A> => {
  browserRuntimePromise ??= makeBrowserRuntime();
  return browserRuntimePromise.then((runtime) => runtime.runPromise(effect, options));
};

/**
 * Lazy compatibility boundary for crypto and passkey Promise adapters. Keeping
 * its layers behind dynamic imports prevents API-only entry points from loading
 * browser crypto and WebAuthn workflows.
 */
export const browserRuntime = { runPromise: runBrowserPromise };

export const requestApi = <S extends Schema.ConstraintDecoder<unknown>>(
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<S["Type"]> => apiRuntime.runPromise(
  ApiClient.use((client) => client.request(path, schema, init)),
  { signal: init?.signal ?? undefined },
);
