import type { Effect } from "effect";

import { registerPasskeyEffect, unlockWithPasskeyEffect } from "../effect/auth";
import { browserRuntime } from "../effect/runtime";

export function registerPasskey(
  existingAccountKey?: CryptoKey,
  turnstileToken?: string,
  options?: Effect.RunOptions,
) {
  return browserRuntime.runPromise(
    registerPasskeyEffect(existingAccountKey, turnstileToken),
    options,
  );
}

export function unlockWithPasskey(options?: Effect.RunOptions) {
  return browserRuntime.runPromise(unlockWithPasskeyEffect(), options);
}
