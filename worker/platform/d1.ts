import { Context, Effect, Layer, Schema } from "effect";

export type D1Parameter = string | number | boolean | null | ArrayBuffer;

export interface D1Statement {
  readonly sql: string;
  readonly params: ReadonlyArray<D1Parameter>;
}

export const D1Operation = Schema.Literals([
  "prepare",
  "bind",
  "all",
  "first",
  "run",
  "batch",
  "decode",
]);
export type D1Operation = typeof D1Operation.Type;

export class D1Error extends Schema.TaggedErrorClass<D1Error>()("D1Error", {
  operation: D1Operation,
  cause: Schema.Defect(),
}) {}

export class D1 extends Context.Service<
  D1,
  {
    readonly prepare: (sql: string) => D1Statement;
    readonly bind: (statement: D1Statement, ...params: ReadonlyArray<D1Parameter>) => D1Statement;
    readonly all: <S extends Schema.Constraint>(
      statement: D1Statement,
      schema: S,
    ) => Effect.Effect<D1Result<S["Type"]>, D1Error, S["DecodingServices"]>;
    readonly first: <S extends Schema.Constraint>(
      statement: D1Statement,
      schema: S,
    ) => Effect.Effect<S["Type"] | null, D1Error, S["DecodingServices"]>;
    readonly run: (statement: D1Statement) => Effect.Effect<D1Result<unknown>, D1Error>;
    readonly batch: (
      statements: ReadonlyArray<D1Statement>,
    ) => Effect.Effect<ReadonlyArray<D1Result<unknown>>, D1Error>;
  }
>()("pastekey/platform/D1") {}

const fail = (operation: D1Operation) => (cause: unknown) => D1Error.make({ operation, cause });

const descriptor = (sql: string, params: ReadonlyArray<D1Parameter>): D1Statement =>
  Object.freeze({ sql, params: Object.freeze([...params]) });

const prepareNative = (database: D1Database, statement: D1Statement) =>
  Effect.try({
    try: () => database.prepare(statement.sql),
    catch: fail("prepare"),
  }).pipe(
    Effect.flatMap((prepared) =>
      statement.params.length === 0
        ? Effect.succeed(prepared)
        : Effect.try({
            try: () => prepared.bind(...statement.params),
            catch: fail("bind"),
          }),
    ),
  );

const decode = <S extends Schema.Constraint>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(fail("decode")));

export const make = (database: D1Database): Context.Service.Shape<typeof D1> => ({
  prepare: (sql) => descriptor(sql, []),
  bind: (statement, ...params) => descriptor(statement.sql, params),

  all: (statement, schema) =>
    Effect.gen(function* () {
      const prepared = yield* prepareNative(database, statement);
      const result = yield* Effect.tryPromise({
        try: () => prepared.all<unknown>(),
        catch: fail("all"),
      });
      const results = yield* Effect.forEach(result.results, (row) => decode(schema, row));
      return { success: result.success, meta: result.meta, results };
    }),

  first: (statement, schema) =>
    Effect.gen(function* () {
      const prepared = yield* prepareNative(database, statement);
      const row = yield* Effect.tryPromise({
        try: () => prepared.first<unknown>(),
        catch: fail("first"),
      });
      return row === null ? null : yield* decode(schema, row);
    }),

  run: (statement) =>
    Effect.gen(function* () {
      const prepared = yield* prepareNative(database, statement);
      return yield* Effect.tryPromise({
        try: () => prepared.run<unknown>(),
        catch: fail("run"),
      });
    }),

  batch: (statements) =>
    Effect.gen(function* () {
      const prepared = yield* Effect.forEach(statements, (statement) => prepareNative(database, statement));
      return yield* Effect.tryPromise({
        try: () => database.batch<unknown>(prepared),
        catch: fail("batch"),
      });
    }),
});

export const layer = (database: D1Database): Layer.Layer<D1> => Layer.succeed(D1, make(database));
