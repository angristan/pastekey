import { env } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { assert, describe, it } from "vitest";
import { D1, layer } from "./d1";

class UserRow extends Schema.Class<UserRow>("D1AdapterUserRow")({
  id: Schema.String,
  createdAt: Schema.Number,
}) {}

function hasD1Binding(value: object): value is { readonly DB: D1Database } {
  return "DB" in value;
}

if (!hasD1Binding(env)) {
  throw new Error("The D1 test binding is unavailable");
}

const D1Test = layer(env.DB);

const effectTest = <A, E>(name: string, test: () => Effect.Effect<A, E, D1>): void => {
  it(name, () => Effect.runPromise(test().pipe(Effect.provide(D1Test))));
};

describe("D1 Effect adapter", () => {
  effectTest("prepares immutable descriptors and decodes all and first rows", () =>
      Effect.gen(function* () {
        const d1 = yield* D1;
        const firstId = "d1-adapter-decode-first";
        const secondId = "d1-adapter-decode-second";

        const prepared = d1.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)");
        const firstInsert = d1.bind(prepared, firstId, 100);
        const secondInsert = d1.bind(prepared, secondId, 200);

        assert.isTrue(Object.isFrozen(prepared));
        assert.isTrue(Object.isFrozen(firstInsert.params));
        assert.deepEqual(prepared.params, []);

        yield* d1.run(
          d1.bind(d1.prepare("DELETE FROM users WHERE id IN (?, ?)"), firstId, secondId),
        );
        const inserted = yield* d1.batch([firstInsert, secondInsert]);
        assert.deepEqual(
          inserted.map((result) => result.meta.changes),
          [1, 1],
        );

        const rows = yield* d1.all(
          d1.bind(
            d1.prepare(
              "SELECT id, created_at AS createdAt FROM users WHERE id IN (?, ?) ORDER BY created_at",
            ),
            firstId,
            secondId,
          ),
          UserRow,
        );
        assert.deepEqual(
          rows.results.map((row) => row.id),
          [firstId, secondId],
        );

        const first = yield* d1.first(
          d1.bind(
            d1.prepare("SELECT id, created_at AS createdAt FROM users WHERE id = ?"),
            firstId,
          ),
          UserRow,
        );
        assert.strictEqual(first?.createdAt, 100);
      }),
    );

  effectTest("preserves run changes and native batch result ordering", () =>
      Effect.gen(function* () {
        const d1 = yield* D1;
        const id = "d1-adapter-meta";

        yield* d1.run(d1.bind(d1.prepare("DELETE FROM users WHERE id = ?"), id));
        const inserted = yield* d1.run(
          d1.bind(d1.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)"), id, 300),
        );
        const unchanged = yield* d1.run(
          d1.bind(d1.prepare("UPDATE users SET created_at = ? WHERE id = ?"), 400, "missing-user"),
        );
        assert.strictEqual(inserted.meta.changes, 1);
        assert.strictEqual(unchanged.meta.changes, 0);

        const ordered = yield* d1.batch([
          d1.bind(d1.prepare("SELECT ? AS value"), "first"),
          d1.bind(d1.prepare("SELECT ? AS value"), "second"),
          d1.bind(d1.prepare("SELECT ? AS value"), "third"),
        ]);
        assert.deepEqual(
          ordered.map((result) => result.results),
          [[{ value: "first" }], [{ value: "second" }], [{ value: "third" }]],
        );
      }),
    );

  effectTest("uses atomic D1 batch rollback semantics", () =>
      Effect.gen(function* () {
        const d1 = yield* D1;
        const id = "d1-adapter-rollback";
        const insert = d1.bind(
          d1.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)"),
          id,
          500,
        );

        yield* d1.run(d1.bind(d1.prepare("DELETE FROM users WHERE id = ?"), id));
        const error = yield* Effect.flip(d1.batch([insert, insert]));
        assert.strictEqual(error._tag, "D1Error");
        assert.strictEqual(error.operation, "batch");

        const row = yield* d1.first(
          d1.bind(
            d1.prepare("SELECT id, created_at AS createdAt FROM users WHERE id = ?"),
            id,
          ),
          UserRow,
        );
        assert.isNull(row);
      }),
    );

  effectTest("maps schema decode failures to D1Error", () =>
      Effect.gen(function* () {
        const d1 = yield* D1;
        const id = "d1-adapter-schema-error";

        yield* d1.run(d1.bind(d1.prepare("DELETE FROM users WHERE id = ?"), id));
        yield* d1.run(
          d1.bind(d1.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)"), id, 600),
        );

        const error = yield* Effect.flip(
          d1.first(
            d1.bind(d1.prepare("SELECT id FROM users WHERE id = ?"), id),
            Schema.Struct({ id: Schema.Number }),
          ),
        );
        assert.strictEqual(error._tag, "D1Error");
        assert.strictEqual(error.operation, "decode");
      }),
    );
});
