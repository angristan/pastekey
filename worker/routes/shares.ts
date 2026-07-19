import { Hono } from "hono";

import { ShareWrite } from "../../shared/schema/pastes";
import { streamAttachmentObject } from "../lib/attachments-http";
import { decodeJsonBody, normalizeExpiry, SMALL_JSON_BODY_BYTES } from "../lib/http";
import { runWorkerEffect } from "../runtime";
import {
  createShare,
  listShares,
  openShare,
  openShareAttachment,
  revokeShare,
} from "../services/paste-mutations";
import { requireUser } from "../services/sessions";
import type { AppEnv } from "../types";

export const shareRoutes = new Hono<AppEnv>();

shareRoutes.get("/api/pastes/:id/shares", requireUser, async (c) => {
  const shares = await runWorkerEffect(
    c.env,
    listShares(c.req.param("id")!, c.get("userId")),
  );
  if (shares === null) return c.json({ error: "Item not found" }, 404);
  return c.json({ shares });
});

shareRoutes.post("/api/pastes/:id/shares", requireUser, async (c) => {
  const body = await runWorkerEffect(
    c.env,
    decodeJsonBody(c, SMALL_JSON_BODY_BYTES, ShareWrite),
  );
  if (body === null) return c.json({ error: "Invalid encrypted share" }, 400);

  const createdAt = await runWorkerEffect(
    c.env,
    createShare(
      c.req.param("id")!,
      c.get("userId"),
      body,
      normalizeExpiry(body.expiresAt),
    ),
  );
  if (createdAt === null) return c.json({ error: "Item not found" }, 404);
  return c.json({ id: body.id, createdAt }, 201);
});

shareRoutes.delete("/api/pastes/:pasteId/shares/:shareId", requireUser, async (c) => {
  const revoked = await runWorkerEffect(
    c.env,
    revokeShare(
      c.req.param("pasteId")!,
      c.req.param("shareId")!,
      c.get("userId"),
    ),
  );
  if (revoked === null) return c.json({ error: "Item not found" }, 404);
  if (!revoked) return c.json({ error: "Share not found" }, 404);
  return c.body(null, 204);
});

shareRoutes.get("/api/shares/:id", async (c) => {
  const share = await runWorkerEffect(c.env, openShare(c.req.param("id")!));
  if (share === null) return c.json({ error: "Share not found or expired" }, 404);
  return c.json(share);
});

shareRoutes.get("/api/shares/:shareId/files/:fileId/content", async (c) => {
  const attachment = await runWorkerEffect(
    c.env,
    openShareAttachment(c.req.param("shareId")!, c.req.param("fileId")!),
  );
  if (attachment === null) {
    return c.json({ error: "Attachment not found or share expired" }, 404);
  }
  return runWorkerEffect(c.env, streamAttachmentObject(attachment.objectKey));
});
