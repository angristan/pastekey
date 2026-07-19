import { Effect } from "effect";

import { FeatureFlags } from "../platform/cloudflare";

export const REGISTRATION_ENABLED_FLAG = "registration-enabled";
const PASTEKEY_FLAG_CONTEXT = { service: "pastekey" };

export type RegistrationAvailability = () => Effect.Effect<boolean, never, FeatureFlags>;

/** Preserve registration if the optional release-control dependency is unavailable. */
export const registrationEnabled: RegistrationAvailability = Effect.fn(
  "pastekey.flags.registration.enabled",
)(function* () {
  const flags = yield* FeatureFlags;
  return yield* flags.getBooleanValue(
    REGISTRATION_ENABLED_FLAG,
    true,
    PASTEKEY_FLAG_CONTEXT,
  ).pipe(
    Effect.catchTag("FeatureFlagError", (error) =>
      Effect.logWarning("Flagship registration flag evaluation failed", error).pipe(
        Effect.as(true),
      )),
  );
});
