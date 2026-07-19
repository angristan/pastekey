import { Effect, Schema } from "effect";

const TurnstileResponse = Schema.Struct({
  success: Schema.Boolean,
  hostname: Schema.optionalKey(Schema.String),
});

export class TurnstileError extends Schema.TaggedErrorClass<TurnstileError>()("TurnstileError", {
  cause: Schema.Defect(),
}) {}

export type TurnstileOutcome =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly status: 400 | 503;
    readonly error: string;
  };

export const verifyTurnstile = Effect.fn("verifyTurnstile")(
  function*(input: {
    readonly requestUrl: string;
    readonly secretKey: string | undefined;
    readonly token: string | undefined;
    readonly remoteIp: string | undefined;
    readonly rpID: string | undefined;
  }) {
    if (!input.secretKey) {
      const hostname = new URL(input.requestUrl).hostname;
      if (hostname === "localhost" || hostname === "127.0.0.1") {
        return { ok: true } satisfies TurnstileOutcome;
      }
      return {
        ok: false,
        status: 503,
        error: "Registration protection is not configured",
      } satisfies TurnstileOutcome;
    }
    if (!input.token || input.token.length > 2048) {
      return {
        ok: false,
        status: 400,
        error: "Complete the human verification first",
      } satisfies TurnstileOutcome;
    }

    const form = new FormData();
    form.set("secret", input.secretKey);
    form.set("response", input.token);
    if (input.remoteIp) form.set("remoteip", input.remoteIp);

    const result = yield* Effect.tryPromise({
      try: () => fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: form,
      }).then((response) => response.json()),
      catch: (cause) => TurnstileError.make({ cause }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(TurnstileResponse)),
      Effect.mapError((cause) => TurnstileError.make({ cause })),
      Effect.catchTag("TurnstileError", (error) =>
        Effect.logError("Turnstile verification failed", error).pipe(
          Effect.as(null),
        )),
    );

    if (result?.success && (!input.rpID || result.hostname === input.rpID)) {
      return { ok: true } satisfies TurnstileOutcome;
    }
    return {
      ok: false,
      status: 400,
      error: "Human verification failed. Please retry.",
    } satisfies TurnstileOutcome;
  },
);
