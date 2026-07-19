import { registerPasskeyEffect, unlockWithPasskeyEffect } from "../effect/auth";
import { browserRuntime } from "../effect/runtime";

export function registerPasskey(existingAccountKey?: CryptoKey, turnstileToken?: string) {
  return browserRuntime.runPromise(registerPasskeyEffect(existingAccountKey, turnstileToken));
}

export function unlockWithPasskey() {
  return browserRuntime.runPromise(unlockWithPasskeyEffect());
}
