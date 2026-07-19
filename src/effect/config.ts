import { Deferred, Effect, Ref } from "effect";

import { AppConfig } from "../../shared/schema/config";
import { ApiClient, type ApiClientError } from "./api";
import { runApiPromise } from "./runtime";

type ConfigState =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Loading"; readonly deferred: Deferred.Deferred<AppConfig, ApiClientError> }
  | { readonly _tag: "Loaded"; readonly value: AppConfig };

type ConfigSelection =
  | { readonly _tag: "Ready"; readonly value: AppConfig }
  | {
    readonly _tag: "Wait";
    readonly deferred: Deferred.Deferred<AppConfig, ApiClientError>;
    readonly start: boolean;
  };

const configState = Ref.makeUnsafe<ConfigState>({ _tag: "Empty" });

const fetchConfig = ApiClient.use((client) =>
  client.request("/api/config", AppConfig),
);

/** Shares successful configuration and resets the cache after failed loads. */
export const appConfigEffect: () => Effect.Effect<AppConfig, ApiClientError, ApiClient> =
  Effect.fn("AppConfig.load")(function*() {
    const selection = yield* Ref.modify(configState, (state): [ConfigSelection, ConfigState] => {
      switch (state._tag) {
        case "Loaded":
          return [{ _tag: "Ready", value: state.value }, state];
        case "Loading":
          return [{ _tag: "Wait", deferred: state.deferred, start: false }, state];
        case "Empty": {
          const deferred = Deferred.makeUnsafe<AppConfig, ApiClientError>();
          return [
            { _tag: "Wait", deferred, start: true },
            { _tag: "Loading", deferred },
          ];
        }
      }
    });

    if (selection._tag === "Ready") return selection.value;

    if (selection.start) {
      const settle = fetchConfig.pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Ref.set(configState, { _tag: "Empty" }).pipe(
              Effect.andThen(Deferred.failCause(selection.deferred, cause)),
              Effect.asVoid,
            ),
          onSuccess: (value) =>
            Ref.set(configState, { _tag: "Loaded", value }).pipe(
              Effect.andThen(Deferred.succeed(selection.deferred, value)),
              Effect.asVoid,
            ),
        }),
      );
      yield* Effect.forkDetach(settle);
    }

    return yield* Deferred.await(selection.deferred);
  });

export const runAppConfig = (options?: Effect.RunOptions) =>
  runApiPromise(appConfigEffect(), options);
