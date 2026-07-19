import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  FeatureFlagError,
  FeatureFlags,
  featureFlagsLayer,
  makeFeatureFlags,
} from "../platform/cloudflare";
import type { FlagshipBinding } from "../types";
import {
  REGISTRATION_ENABLED_FLAG,
  registrationEnabled,
} from "./feature-flags";

class FakeFlagshipBinding implements FlagshipBinding {
  readonly calls: Array<{
    flagKey: string;
    defaultValue: boolean;
    context: FlagshipEvaluationContext | undefined;
  }> = [];

  constructor(private readonly value: boolean) {}

  getBooleanValue(
    flagKey: string,
    defaultValue: boolean,
    context?: FlagshipEvaluationContext,
  ): Promise<boolean> {
    this.calls.push({ flagKey, defaultValue, context });
    return Promise.resolve(this.value);
  }
}

const binding = new FakeFlagshipBinding(false);

layer(featureFlagsLayer(binding))("registration feature flag", (it) => {
  it.effect("uses the Flagship value with the current behavior as its default", () =>
    Effect.gen(function* () {
      const enabled = yield* registrationEnabled();

      assert.isFalse(enabled);
      assert.deepStrictEqual(binding.calls, [{
        flagKey: REGISTRATION_ENABLED_FLAG,
        defaultValue: true,
        context: { service: "pastekey" },
      }]);
    }),
  );
});

layer(featureFlagsLayer({
  getBooleanValue: () => Promise.reject(new Error("Flagship unavailable")),
}))("registration feature flag failure", (it) => {
  it.effect("fails open when Flagship is unavailable", () =>
    Effect.gen(function* () {
      const enabled = yield* registrationEnabled();
      assert.isTrue(enabled);
    }),
  );
});

layer(featureFlagsLayer(new FakeFlagshipBinding(false)))("Flagship platform adapter", (it) => {
  it.effect("maps binding failures to typed errors", () =>
    Effect.gen(function* () {
      const cause = new Error("binding failed");
      const flags = makeFeatureFlags({
        getBooleanValue: () => Promise.reject(cause),
      });
      const error = yield* Effect.flip(flags.getBooleanValue("test-flag", false));

      assert.instanceOf(error, FeatureFlagError);
      assert.strictEqual(error.flagKey, "test-flag");
      assert.strictEqual(error.cause, cause);

      const service = yield* FeatureFlags;
      assert.isFalse(yield* service.getBooleanValue(REGISTRATION_ENABLED_FLAG, true));
    }),
  );
});
