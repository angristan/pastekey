import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";

import type {
  AppConfig,
  AuthSuccess,
  MeResponse,
  StoredAttachment,
  StoredPaste,
  StoredShare,
  WrappedKey,
} from "../src/lib/types";

type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  AUTH_RATE_LIMITER: RateLimit;
  WRITE_RATE_LIMITER: RateLimit;
  MAX_FILE_BYTES?: string;
  MAX_FILES_PER_PASTE?: string;
  MAX_PASTES_PER_USER?: string;
  MAX_STORAGE_BYTES?: string;
  ORIGIN?: string;
  RP_ID?: string;
  RP_NAME?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
};

type Variables = {
  userId: string;
};

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

type ChallengeRow = {
  id: string;
  challenge: string;
  kind: "register" | "add-passkey" | "login";
  user_id: string | null;
  expires_at: number;
};

type CredentialRow = {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string;
  device_type: string;
  backed_up: number;
  wrapped_account_key: string;
  wrapped_account_key_iv: string;
};

type PasteWrite = {
  id: string;
  ciphertext: string;
  contentIv: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  expiresAt?: number | null;
};

type ShareWrite = {
  id: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  expiresAt?: number | null;
};

type AttachmentRow = StoredAttachment & {
  objectKey: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const SESSION_COOKIE = "pk_session";
const CEREMONY_COOKIE = "pk_ceremony";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const CEREMONY_TTL_SECONDS = 60 * 5;
const MAX_CIPHERTEXT_LENGTH = 1_000_000;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_PASTE = 10;
const DEFAULT_MAX_PASTES_PER_USER = 100;
const DEFAULT_MAX_STORAGE_BYTES = 100 * 1024 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9_-]{20,64}$/;

app.use("/api/*", secureHeaders());
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.use("/api/auth/*", async (c, next) => {
  if (c.req.method === "POST" && !(await consumeRateLimit(c, c.env.AUTH_RATE_LIMITER, "auth"))) {
    return c.json({ error: "Too many authentication attempts. Try again shortly." }, 429);
  }
  await next();
});
app.use("/api/pastes/*", async (c, next) => {
  if (["POST", "PUT", "DELETE"].includes(c.req.method) && !(await consumeRateLimit(c, c.env.WRITE_RATE_LIMITER, "write"))) {
    return c.json({ error: "Too many changes. Try again shortly." }, 429);
  }
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/api/config", (c) => {
  const limits = serviceLimits(c.env);
  const hostname = new URL(c.req.url).hostname;
  const localWithoutSecret = (hostname === "localhost" || hostname === "127.0.0.1") && !c.env.TURNSTILE_SECRET_KEY;
  return c.json<AppConfig>({
    limits,
    turnstileSiteKey: localWithoutSecret ? null : (c.env.TURNSTILE_SITE_KEY ?? null),
  });
});

app.post("/api/auth/register/options", async (c) => {
  const existing = await currentUser(c);
  if (existing) return c.json({ error: "Already signed in" }, 409);

  const body = await readJson<{ turnstileToken?: string }>(c);
  const turnstile = await verifyTurnstile(c, body?.turnstileToken);
  if (!turnstile.ok) return c.json({ error: turnstile.error }, turnstile.status);

  const userId = randomId();
  return beginRegistration(c, userId, "register", []);
});

app.post("/api/auth/passkeys/options", requireUser, async (c) => {
  const userId = c.get("userId");
  const credentials = await c.env.DB.prepare("SELECT id, transports FROM credentials WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string; transports: string }>();

  const excluded = credentials.results.map((credential) => ({
    id: credential.id,
    transports: parseTransports(credential.transports),
  }));

  return beginRegistration(c, userId, "add-passkey", excluded);
});

app.post("/api/auth/register/verify", async (c) => {
  const ceremony = await getCeremony(c, ["register", "add-passkey"]);
  if (!ceremony) return c.json({ error: "Registration ceremony expired" }, 400);

  const body = await readJson<{
    credential: RegistrationResponseJSON;
    wrappedAccountKey: WrappedKey;
  }>(c);
  if (!body || !validWrappedKey(body.wrappedAccountKey)) {
    return c.json({ error: "Invalid registration response" }, 400);
  }

  const { rpID, origin } = relyingParty(c);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return c.json({ error: "Passkey registration could not be verified" }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "Passkey registration failed" }, 400);
  }

  const info = verification.registrationInfo;
  const credential = info.credential;
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  if (ceremony.kind === "register") {
    statements.push(c.env.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").bind(ceremony.user_id, now));
  } else {
    const activeUser = await currentUser(c);
    if (!activeUser || activeUser !== ceremony.user_id) {
      return c.json({ error: "Sign in again before adding a passkey" }, 401);
    }
  }

  statements.push(
    c.env.DB.prepare(
      `INSERT INTO credentials (
        id, user_id, public_key, counter, transports, device_type, backed_up,
        wrapped_account_key, wrapped_account_key_iv, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      credential.id,
      ceremony.user_id,
      toBase64Url(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0,
      body.wrappedAccountKey.ciphertext,
      body.wrappedAccountKey.iv,
      now,
    ),
    c.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(ceremony.id),
  );

  try {
    await c.env.DB.batch(statements);
  } catch {
    return c.json({ error: "This passkey is already registered" }, 409);
  }

  deleteCookie(c, CEREMONY_COOKIE, { path: "/api/auth" });
  if (ceremony.kind === "register") await createSession(c, ceremony.user_id!);

  const response: AuthSuccess = {
    userId: ceremony.user_id!,
    credentialId: credential.id,
    wrappedAccountKey: body.wrappedAccountKey,
  };
  return c.json(response, 201);
});

app.post("/api/auth/login/options", async (c) => {
  const { rpID } = relyingParty(c);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
  });

  await storeCeremony(c, options.challenge, "login", null);
  return c.json(options);
});

app.post("/api/auth/login/verify", async (c) => {
  const ceremony = await getCeremony(c, ["login"]);
  if (!ceremony) return c.json({ error: "Sign-in ceremony expired" }, 400);

  const body = await readJson<{ credential: AuthenticationResponseJSON }>(c);
  if (!body?.credential?.id) return c.json({ error: "Invalid sign-in response" }, 400);

  const stored = await c.env.DB.prepare("SELECT * FROM credentials WHERE id = ?")
    .bind(body.credential.id)
    .first<CredentialRow>();
  if (!stored) return c.json({ error: "Unknown passkey" }, 401);

  const { rpID, origin } = relyingParty(c);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.credential,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: stored.id,
        publicKey: fromBase64Url(stored.public_key),
        counter: stored.counter,
        transports: parseTransports(stored.transports),
      },
      requireUserVerification: true,
    });
  } catch {
    return c.json({ error: "Passkey sign-in could not be verified" }, 401);
  }

  if (!verification.verified) return c.json({ error: "Passkey sign-in failed" }, 401);

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?").bind(
      verification.authenticationInfo.newCounter,
      Date.now(),
      stored.id,
    ),
    c.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(ceremony.id),
  ]);
  deleteCookie(c, CEREMONY_COOKIE, { path: "/api/auth" });
  await createSession(c, stored.user_id);

  const response: AuthSuccess = {
    userId: stored.user_id,
    credentialId: stored.id,
    wrappedAccountKey: {
      ciphertext: stored.wrapped_account_key,
      iv: stored.wrapped_account_key_iv,
    },
  };
  return c.json(response);
});

app.get("/api/auth/me", async (c) => {
  const userId = await currentUser(c);
  if (!userId) return c.json<MeResponse>({ authenticated: false });

  const passkeys = await c.env.DB.prepare(
    `SELECT id, created_at AS createdAt, last_used_at AS lastUsedAt,
      backed_up AS backedUp, device_type AS deviceType
     FROM credentials WHERE user_id = ? ORDER BY created_at`,
  )
    .bind(userId)
    .all<{ id: string; createdAt: number; lastUsedAt: number | null; backedUp: number; deviceType: string }>();

  return c.json<MeResponse>({
    authenticated: true,
    userId,
    passkeys: passkeys.results.map((key) => ({ ...key, backedUp: Boolean(key.backedUp) })),
  });
});

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await hashToken(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.body(null, 204);
});

app.delete("/api/auth/passkeys/:id", requireUser, async (c) => {
  const userId = c.get("userId");
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM credentials WHERE user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  if (!count || count.count <= 1) return c.json({ error: "Keep at least one passkey" }, 409);

  const result = await c.env.DB.prepare("DELETE FROM credentials WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), userId)
    .run();
  if (!result.meta.changes) return c.json({ error: "Passkey not found" }, 404);
  return c.body(null, 204);
});

app.get("/api/pastes", requireUser, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, ciphertext, content_iv AS contentIv, wrapped_key AS wrappedKey,
      wrapped_key_iv AS wrappedKeyIv, created_at AS createdAt, updated_at AS updatedAt,
      expires_at AS expiresAt, version
     FROM pastes
     WHERE owner_id = ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY updated_at DESC`,
  )
    .bind(c.get("userId"), Date.now())
    .all<StoredPaste>();
  return c.json({ pastes: rows.results });
});

app.get("/api/pastes/:id", requireUser, async (c) => {
  const paste = await getOwnedPaste(c, c.req.param("id")!);
  if (!paste) return c.json({ error: "Paste not found" }, 404);
  return c.json(paste);
});

app.post("/api/pastes", requireUser, async (c) => {
  const body = await readJson<PasteWrite>(c);
  if (!validPasteWrite(body)) return c.json({ error: "Invalid encrypted paste" }, 400);

  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM pastes WHERE owner_id = ?")
    .bind(c.get("userId"))
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= serviceLimits(c.env).maxPastesPerUser) {
    return c.json({ error: "Paste quota reached. Delete a paste before creating another." }, 413);
  }

  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO pastes (
        id, owner_id, ciphertext, content_iv, wrapped_key, wrapped_key_iv,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        body.id,
        c.get("userId"),
        body.ciphertext,
        body.contentIv,
        body.wrappedKey,
        body.wrappedKeyIv,
        now,
        now,
        normalizeExpiry(body.expiresAt),
      )
      .run();
  } catch {
    return c.json({ error: "Paste ID already exists" }, 409);
  }
  return c.json({ id: body.id, createdAt: now }, 201);
});

app.put("/api/pastes/:id", requireUser, async (c) => {
  const body = await readJson<Omit<PasteWrite, "id">>(c);
  const id = c.req.param("id")!;
  if (!validPasteWrite(body ? { ...body, id } : null)) return c.json({ error: "Invalid encrypted paste" }, 400);

  const result = await c.env.DB.prepare(
    `UPDATE pastes SET ciphertext = ?, content_iv = ?, wrapped_key = ?, wrapped_key_iv = ?,
      updated_at = ?, expires_at = ?, version = version + 1
     WHERE id = ? AND owner_id = ?`,
  )
    .bind(
      body!.ciphertext,
      body!.contentIv,
      body!.wrappedKey,
      body!.wrappedKeyIv,
      Date.now(),
      normalizeExpiry(body!.expiresAt),
      id,
      c.get("userId"),
    )
    .run();
  if (!result.meta.changes) return c.json({ error: "Paste not found" }, 404);
  return c.json({ id });
});

app.delete("/api/pastes/:id", requireUser, async (c) => {
  const pasteId = c.req.param("id")!;
  const objects = await c.env.DB.prepare(
    `SELECT a.object_key AS objectKey FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE p.id = ? AND p.owner_id = ?`,
  )
    .bind(pasteId, c.get("userId"))
    .all<{ objectKey: string }>();
  if (objects.results.length) await c.env.FILES.delete(objects.results.map((item) => item.objectKey));

  const result = await c.env.DB.prepare("DELETE FROM pastes WHERE id = ? AND owner_id = ?")
    .bind(pasteId, c.get("userId"))
    .run();
  if (!result.meta.changes) return c.json({ error: "Paste not found" }, 404);
  return c.body(null, 204);
});

app.get("/api/pastes/:id/files", requireUser, async (c) => {
  const pasteId = c.req.param("id")!;
  const paste = await c.env.DB.prepare("SELECT id FROM pastes WHERE id = ? AND owner_id = ?")
    .bind(pasteId, c.get("userId"))
    .first();
  if (!paste) return c.json({ error: "Paste not found" }, 404);
  return c.json({ attachments: await listAttachments(c.env.DB, pasteId) });
});

app.put("/api/pastes/:pasteId/files/:fileId", requireUser, async (c) => {
  const pasteId = c.req.param("pasteId")!;
  const fileId = c.req.param("fileId")!;
  const userId = c.get("userId");
  const limits = serviceLimits(c.env);
  const length = Number(c.req.header("Content-Length"));

  if (!OPAQUE_ID.test(fileId)) return c.json({ error: "Invalid attachment ID" }, 400);
  if (!Number.isSafeInteger(length) || length <= 16) return c.json({ error: "Content-Length is required" }, 411);
  if (length > limits.maxFileBytes + 16) return c.json({ error: "Encrypted file exceeds the size limit" }, 413);

  const fields = readAttachmentHeaders(c.req.raw.headers);
  if (!fields) return c.json({ error: "Invalid encrypted attachment metadata" }, 400);

  const paste = await c.env.DB.prepare("SELECT id FROM pastes WHERE id = ? AND owner_id = ?")
    .bind(pasteId, userId)
    .first();
  if (!paste) return c.json({ error: "Paste not found" }, 404);

  const existing = await c.env.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind(fileId).first();
  if (existing) return c.json({ error: "Attachment ID already exists" }, 409);

  const [fileCount, storage] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM attachments WHERE paste_id = ?")
      .bind(pasteId)
      .first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(a.ciphertext_size), 0) AS bytes FROM attachments a
       JOIN pastes p ON p.id = a.paste_id WHERE p.owner_id = ?`,
    )
      .bind(userId)
      .first<{ bytes: number }>(),
  ]);
  if ((fileCount?.count ?? 0) >= limits.maxFilesPerPaste) {
    return c.json({ error: "Attachment limit reached for this paste" }, 413);
  }
  if ((storage?.bytes ?? 0) + length > limits.maxStorageBytes) {
    return c.json({ error: "Account storage quota exceeded" }, 413);
  }
  if (!c.req.raw.body) return c.json({ error: "Encrypted file body is required" }, 400);

  const objectKey = `${userId}/${pasteId}/${fileId}`;
  await c.env.FILES.put(objectKey, c.req.raw.body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO attachments (
        id, paste_id, object_key, ciphertext_size, content_iv, wrapped_key, wrapped_key_iv,
        metadata_ciphertext, metadata_iv, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        fileId,
        pasteId,
        objectKey,
        length,
        fields.contentIv,
        fields.wrappedKey,
        fields.wrappedKeyIv,
        fields.metadataCiphertext,
        fields.metadataIv,
        now,
      )
      .run();
  } catch {
    await c.env.FILES.delete(objectKey);
    return c.json({ error: "Attachment could not be saved" }, 409);
  }

  return c.json({ id: fileId, createdAt: now }, 201);
});

app.get("/api/pastes/:pasteId/files/:fileId/content", requireUser, async (c) => {
  const attachment = await c.env.DB.prepare(
    `SELECT a.object_key AS objectKey FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE a.id = ? AND p.id = ? AND p.owner_id = ?`,
  )
    .bind(c.req.param("fileId"), c.req.param("pasteId"), c.get("userId"))
    .first<{ objectKey: string }>();
  if (!attachment) return c.json({ error: "Attachment not found" }, 404);
  return streamR2Object(c, attachment.objectKey);
});

app.delete("/api/pastes/:pasteId/files/:fileId", requireUser, async (c) => {
  const attachment = await c.env.DB.prepare(
    `SELECT a.object_key AS objectKey FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE a.id = ? AND p.id = ? AND p.owner_id = ?`,
  )
    .bind(c.req.param("fileId"), c.req.param("pasteId"), c.get("userId"))
    .first<{ objectKey: string }>();
  if (!attachment) return c.json({ error: "Attachment not found" }, 404);

  await c.env.FILES.delete(attachment.objectKey);
  await c.env.DB.prepare("DELETE FROM attachments WHERE id = ? AND paste_id = ?")
    .bind(c.req.param("fileId"), c.req.param("pasteId"))
    .run();
  return c.body(null, 204);
});

app.get("/api/pastes/:id/shares", requireUser, async (c) => {
  const owned = await c.env.DB.prepare("SELECT id FROM pastes WHERE id = ? AND owner_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .first();
  if (!owned) return c.json({ error: "Paste not found" }, 404);

  const shares = await c.env.DB.prepare(
    `SELECT id, created_at AS createdAt, expires_at AS expiresAt
     FROM shares WHERE paste_id = ? ORDER BY created_at DESC`,
  )
    .bind(c.req.param("id"))
    .all<{ id: string; createdAt: number; expiresAt: number | null }>();
  return c.json({ shares: shares.results });
});

app.post("/api/pastes/:id/shares", requireUser, async (c) => {
  const body = await readJson<ShareWrite>(c);
  if (!body || !OPAQUE_ID.test(body.id) || !validOpaque(body.wrappedKey) || !validOpaque(body.wrappedKeyIv)) {
    return c.json({ error: "Invalid encrypted share" }, 400);
  }

  const paste = await c.env.DB.prepare("SELECT id FROM pastes WHERE id = ? AND owner_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .first();
  if (!paste) return c.json({ error: "Paste not found" }, 404);

  const now = Date.now();
  try {
    await c.env.DB.prepare(
      "INSERT INTO shares (id, paste_id, wrapped_key, wrapped_key_iv, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(body.id, c.req.param("id"), body.wrappedKey, body.wrappedKeyIv, now, normalizeExpiry(body.expiresAt))
      .run();
  } catch {
    return c.json({ error: "Share ID already exists" }, 409);
  }
  return c.json({ id: body.id, createdAt: now }, 201);
});

app.delete("/api/pastes/:pasteId/shares/:shareId", requireUser, async (c) => {
  const result = await c.env.DB.prepare(
    `DELETE FROM shares WHERE id = ? AND paste_id = ? AND paste_id IN
      (SELECT id FROM pastes WHERE owner_id = ?)`,
  )
    .bind(c.req.param("shareId"), c.req.param("pasteId"), c.get("userId"))
    .run();
  if (!result.meta.changes) return c.json({ error: "Share not found" }, 404);
  return c.body(null, 204);
});

app.get("/api/shares/:id", async (c) => {
  const now = Date.now();
  const share = await c.env.DB.prepare(
    `SELECT s.id, s.paste_id AS pasteId, p.ciphertext, p.content_iv AS contentIv,
      s.wrapped_key AS wrappedKey, s.wrapped_key_iv AS wrappedKeyIv,
      s.created_at AS createdAt, p.updated_at AS updatedAt, s.expires_at AS expiresAt
     FROM shares s JOIN pastes p ON p.id = s.paste_id
     WHERE s.id = ? AND (s.expires_at IS NULL OR s.expires_at > ?)
       AND (p.expires_at IS NULL OR p.expires_at > ?)`,
  )
    .bind(c.req.param("id"), now, now)
    .first<Omit<StoredShare, "attachments">>();
  if (!share) return c.json({ error: "Share not found or expired" }, 404);
  const attachments = await listAttachments(c.env.DB, share.pasteId);
  return c.json({ ...share, attachments });
});

app.get("/api/shares/:shareId/files/:fileId/content", async (c) => {
  const now = Date.now();
  const attachment = await c.env.DB.prepare(
    `SELECT a.object_key AS objectKey FROM attachments a
     JOIN pastes p ON p.id = a.paste_id
     JOIN shares s ON s.paste_id = p.id
     WHERE a.id = ? AND s.id = ?
       AND (s.expires_at IS NULL OR s.expires_at > ?)
       AND (p.expires_at IS NULL OR p.expires_at > ?)`,
  )
    .bind(c.req.param("fileId"), c.req.param("shareId"), now, now)
    .first<{ objectKey: string }>();
  if (!attachment) return c.json({ error: "Attachment not found or share expired" }, 404);
  return streamR2Object(c, attachment.objectKey);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  console.error("Unhandled API error", error);
  return c.json({ error: "Unexpected server error" }, 500);
});

async function beginRegistration(
  c: AppContext,
  userId: string,
  kind: "register" | "add-passkey",
  excludeCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[],
) {
  const { rpID } = relyingParty(c);
  const options = await generateRegistrationOptions({
    rpName: c.env.RP_NAME ?? "Pastekey",
    rpID,
    userID: fromBase64Url(userId),
    userName: `pastekey-${userId.slice(0, 8)}`,
    userDisplayName: "Pastekey user",
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    supportedAlgorithmIDs: [-7, -257],
  });

  await storeCeremony(c, options.challenge, kind, userId);
  return c.json(options);
}

async function storeCeremony(
  c: AppContext,
  challenge: string,
  kind: ChallengeRow["kind"],
  userId: string | null,
) {
  const id = randomId();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    c.env.DB.prepare(
      "INSERT INTO auth_challenges (id, challenge, kind, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, challenge, kind, userId, now, now + CEREMONY_TTL_SECONDS * 1000),
  ]);
  setCookie(c, CEREMONY_COOKIE, id, cookieOptions(c, CEREMONY_TTL_SECONDS, "/api/auth"));
}

async function getCeremony(c: AppContext, kinds: ChallengeRow["kind"][]) {
  const id = getCookie(c, CEREMONY_COOKIE);
  if (!id) return null;
  const row = await c.env.DB.prepare("SELECT * FROM auth_challenges WHERE id = ? AND expires_at > ?")
    .bind(id, Date.now())
    .first<ChallengeRow>();
  if (!row || !kinds.includes(row.kind)) return null;
  return row;
}

async function requireUser(c: AppContext, next: () => Promise<void>) {
  const userId = await currentUser(c);
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  c.set("userId", userId);
  await next();
}

async function currentUser(c: AppContext) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = await c.env.DB.prepare("SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?")
    .bind(await hashToken(token), Date.now())
    .first<{ user_id: string }>();
  return session?.user_id ?? null;
}

async function createSession(c: AppContext, userId: string) {
  const token = randomId(32);
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await hashToken(token), userId, now, now + SESSION_TTL_SECONDS * 1000)
    .run();
  setCookie(c, SESSION_COOKIE, token, cookieOptions(c, SESSION_TTL_SECONDS, "/"));
}

function cookieOptions(c: AppContext, maxAge: number, path: string) {
  return {
    httpOnly: true,
    sameSite: "Strict" as const,
    secure: new URL(c.req.url).protocol === "https:",
    path,
    maxAge,
  };
}

function relyingParty(c: AppContext) {
  const url = new URL(c.req.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return {
    rpID: local ? url.hostname : (c.env.RP_ID ?? url.hostname),
    origin: local ? url.origin : (c.env.ORIGIN ?? url.origin),
  };
}

async function getOwnedPaste(c: AppContext, id: string) {
  return c.env.DB.prepare(
    `SELECT id, ciphertext, content_iv AS contentIv, wrapped_key AS wrappedKey,
      wrapped_key_iv AS wrappedKeyIv, created_at AS createdAt, updated_at AS updatedAt,
      expires_at AS expiresAt, version
     FROM pastes WHERE id = ? AND owner_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(id, c.get("userId"), Date.now())
    .first<StoredPaste>();
}

async function listAttachments(db: D1Database, pasteId: string) {
  const rows = await db.prepare(
    `SELECT id, paste_id AS pasteId, ciphertext_size AS ciphertextSize, content_iv AS contentIv,
      wrapped_key AS wrappedKey, wrapped_key_iv AS wrappedKeyIv,
      metadata_ciphertext AS metadataCiphertext, metadata_iv AS metadataIv, created_at AS createdAt
     FROM attachments WHERE paste_id = ? ORDER BY created_at`,
  )
    .bind(pasteId)
    .all<StoredAttachment>();
  return rows.results;
}

function readAttachmentHeaders(headers: Headers) {
  const fields = {
    contentIv: headers.get("X-Pastekey-Content-IV"),
    wrappedKey: headers.get("X-Pastekey-Wrapped-Key"),
    wrappedKeyIv: headers.get("X-Pastekey-Wrapped-Key-IV"),
    metadataCiphertext: headers.get("X-Pastekey-Metadata"),
    metadataIv: headers.get("X-Pastekey-Metadata-IV"),
  };
  if (
    !validOpaque(fields.contentIv) ||
    !validOpaque(fields.wrappedKey) ||
    !validOpaque(fields.wrappedKeyIv) ||
    !validOpaque(fields.metadataCiphertext, 20_000) ||
    !validOpaque(fields.metadataIv)
  ) {
    return null;
  }
  return fields as Record<keyof typeof fields, string>;
}

async function streamR2Object(c: AppContext, objectKey: string) {
  const object = await c.env.FILES.get(objectKey);
  if (!object) return c.json({ error: "Encrypted attachment data not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Length": String(object.size),
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function serviceLimits(env: Bindings) {
  return {
    maxFileBytes: positiveInteger(env.MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    maxFilesPerPaste: positiveInteger(env.MAX_FILES_PER_PASTE, DEFAULT_MAX_FILES_PER_PASTE),
    maxPastesPerUser: positiveInteger(env.MAX_PASTES_PER_USER, DEFAULT_MAX_PASTES_PER_USER),
    maxStorageBytes: positiveInteger(env.MAX_STORAGE_BYTES, DEFAULT_MAX_STORAGE_BYTES),
  };
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function consumeRateLimit(c: AppContext, limiter: RateLimit, scope: string) {
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  try {
    return (await limiter.limit({ key: `${scope}:${ip}` })).success;
  } catch (error) {
    console.error("Rate limiter unavailable", error);
    return true;
  }
}

async function verifyTurnstile(c: AppContext, token: string | undefined) {
  if (!c.env.TURNSTILE_SECRET_KEY) {
    const hostname = new URL(c.req.url).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") return { ok: true } as const;
    return { ok: false, status: 503 as const, error: "Registration protection is not configured" };
  }
  if (!token || token.length > 2048) {
    return { ok: false, status: 400 as const, error: "Complete the human verification first" };
  }

  const form = new FormData();
  form.set("secret", c.env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  const ip = c.req.header("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const result = await response.json<{ success: boolean; hostname?: string }>();
    if (result.success && (!c.env.RP_ID || result.hostname === c.env.RP_ID)) return { ok: true } as const;
  } catch (error) {
    console.error("Turnstile verification failed", error);
  }
  return { ok: false, status: 400 as const, error: "Human verification failed. Please retry." };
}

async function cleanupExpired(env: Bindings) {
  const now = Date.now();
  const expired = await env.DB.prepare(
    `SELECT a.id, a.object_key AS objectKey FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE p.expires_at IS NOT NULL AND p.expires_at <= ? LIMIT 100`,
  )
    .bind(now)
    .all<{ id: string; objectKey: string }>();

  if (expired.results.length) {
    await env.FILES.delete(expired.results.map((item) => item.objectKey));
    const placeholders = expired.results.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM attachments WHERE id IN (${placeholders})`)
      .bind(...expired.results.map((item) => item.id))
      .run();
  }

  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM pastes WHERE expires_at IS NOT NULL AND expires_at <= ?
       AND NOT EXISTS (SELECT 1 FROM attachments WHERE attachments.paste_id = pastes.id)`,
    ).bind(now),
    env.DB.prepare("DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
  ]);
}

function validPasteWrite(body: PasteWrite | null): body is PasteWrite {
  return Boolean(
    body &&
      OPAQUE_ID.test(body.id) &&
      validOpaque(body.ciphertext, MAX_CIPHERTEXT_LENGTH) &&
      validOpaque(body.contentIv) &&
      validOpaque(body.wrappedKey) &&
      validOpaque(body.wrappedKeyIv) &&
      validExpiry(body.expiresAt),
  );
}

function validWrappedKey(value: WrappedKey | null | undefined): value is WrappedKey {
  return Boolean(value && validOpaque(value.ciphertext) && validOpaque(value.iv));
}

function validOpaque(value: unknown, maxLength = 10_000) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(value);
}

function validExpiry(value: unknown) {
  return value === undefined || value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > Date.now());
}

function normalizeExpiry(value: number | null | undefined) {
  return value ?? null;
}

function parseTransports(value: string): AuthenticatorTransportFuture[] {
  try {
    return JSON.parse(value) as AuthenticatorTransportFuture[];
  } catch {
    return [];
  }
}

async function readJson<T>(c: AppContext): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

function randomId(bytes = 16) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export default {
  fetch: app.fetch,
  scheduled(_controller, env, context) {
    context.waitUntil(cleanupExpired(env));
  },
} satisfies ExportedHandler<Bindings>;
