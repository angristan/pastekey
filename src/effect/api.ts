import { Context, Effect, Layer, Schema } from "effect";

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ApiTransportError extends Schema.TaggedErrorClass<ApiTransportError>()(
  "ApiTransportError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ApiStatusError extends Schema.TaggedErrorClass<ApiStatusError>()(
  "ApiStatusError",
  {
    message: Schema.String,
    status: Schema.Number,
  },
) {}

export class ApiDecodeError extends Schema.TaggedErrorClass<ApiDecodeError>()(
  "ApiDecodeError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type ApiClientError = ApiTransportError | ApiStatusError | ApiDecodeError;

export class ApiClient extends Context.Service<ApiClient, {
  readonly request: <S extends Schema.Top>(
    path: string,
    schema: S,
    init?: RequestInit,
  ) => Effect.Effect<S["Type"], ApiClientError, S["DecodingServices"]>;
}>()("pastekey/ApiClient") {}

const readResponseText = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => ApiTransportError.make({
      message: "Failed to read the API response body",
      cause,
    }),
  });

const parseJson = (text: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) => ApiDecodeError.make({
      message: "Failed to parse the API response as JSON",
      cause,
    }),
  });

const errorMessage = (body: unknown): string | undefined => {
  if (
    typeof body === "object"
    && body !== null
    && "error" in body
    && typeof body.error === "string"
    && body.error.length > 0
  ) {
    return body.error;
  }
  return undefined;
};

const statusMessage = (response: Response) => {
  const fallback = `Request failed (${response.status})`;
  return readResponseText(response).pipe(
    Effect.flatMap(parseJson),
    Effect.map((body) => errorMessage(body) ?? fallback),
    Effect.orElseSucceed(() => fallback),
  );
};

export const makeApiClient = (fetchImplementation: FetchImplementation) => ApiClient.of({
  request: <S extends Schema.Top>(path: string, schema: S, init?: RequestInit) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) => fetchImplementation(path, {
          ...init,
          headers: {
            ...(typeof init?.body === "string" ? { "Content-Type": "application/json" } : {}),
            ...init?.headers,
          },
          signal,
        }),
        catch: (cause) => ApiTransportError.make({
          message: "API request failed before receiving a response",
          cause,
        }),
      });

      if (!response.ok) {
        return yield* ApiStatusError.make({
          message: yield* statusMessage(response),
          status: response.status,
        });
      }

      const body: unknown = response.status === 204
        ? undefined
        : yield* readResponseText(response).pipe(Effect.flatMap(parseJson));

      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError((cause) => ApiDecodeError.make({
          message: "API response did not match the expected schema",
          cause,
        })),
      );
    }),
});

export const ApiClientLive = Layer.succeed(ApiClient)(
  makeApiClient((input, init) => globalThis.fetch(input, init)),
);
