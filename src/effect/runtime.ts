import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import { ApiClient, ApiClientLive } from "./api";
import type { BrowserCrypto } from "./crypto";
import type { WebAuthn } from "./webauthn";

const apiRuntime = ManagedRuntime.make(ApiClientLive);

/** Promise boundary for browser effects that require the API service. */
export const runApiPromise = <A, E>(
  effect: Effect.Effect<A, E, ApiClient>,
  options?: Effect.RunOptions,
): Promise<A> => apiRuntime.runPromise(effect, options);

/** Promise boundary for service-free browser effects and compatibility adapters. */
export const runClientPromise = <A, E>(
  effect: Effect.Effect<A, E>,
  options?: Effect.RunOptions,
): Promise<A> => Effect.runPromise(effect, options);

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
): Promise<S["Type"]> => runApiPromise(
  ApiClient.use((client) => client.request(path, schema, init)),
  { signal: init?.signal ?? undefined },
);
