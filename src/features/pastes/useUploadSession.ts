import { useEffect, useRef, useState } from "react";

import type { StoredAttachment } from "../../../shared/protocol/attachments";
import { api, ApiError } from "../../lib/api";
import { encryptAttachment } from "../../lib/crypto";
import { messageOf } from "../../lib/format";
import { uploadWithRetry } from "../../lib/uploads";

type UploadPhase = "pending" | "encrypting" | "uploading" | "retrying" | "complete" | "error";
type EncryptedAttachment = Awaited<ReturnType<typeof encryptAttachment>>;

export type SelectedFile = {
  id: string;
  file: File;
  phase: UploadPhase;
  progress: number;
  attempt?: number;
  maxAttempts?: number;
  error?: string;
};

export type UploadSession = {
  pasteId: string;
  pasteKey: CryptoKey;
};

export type UploadPayloadCache = ReturnType<typeof createUploadPayloadCache>;

type UploadDependencies = {
  encrypt: typeof encryptAttachment;
  upload: typeof uploadWithRetry;
  list: (pasteId: string) => Promise<StoredAttachment[]>;
};

const defaultDependencies: UploadDependencies = {
  encrypt: encryptAttachment,
  upload: uploadWithRetry,
  list: async (pasteId) => {
    const response = await api<{ attachments: StoredAttachment[] }>(`/api/pastes/${pasteId}/files`);
    return response.attachments;
  },
};

let nextSelectionId = 0;

export function useUploadSession() {
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [session, setSession] = useState<UploadSession | null>(null);
  const payloads = useRef(createUploadPayloadCache());

  useEffect(() => () => payloads.current.clear(), []);

  function appendFiles(selected: File[]) {
    setFiles((current) => [
      ...current,
      ...selected.map((file) => ({
        id: `selected-${Date.now()}-${nextSelectionId++}`,
        file,
        phase: "pending" as const,
        progress: 0,
      })),
    ]);
  }

  function removeFile(id: string) {
    payloads.current.release(id);
    setFiles((current) => current.filter((item) => item.id !== id));
  }

  function updateFile(id: string, patch: Partial<SelectedFile>) {
    setFiles((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function uploadFile(selected: SelectedFile, uploadSession: UploadSession) {
    return uploadSelectedFile({
      selected,
      session: uploadSession,
      payloads: payloads.current,
      update: (patch) => updateFile(selected.id, patch),
    });
  }

  function beginSession(uploadSession: UploadSession) {
    setSession(uploadSession);
  }

  function finishSession() {
    payloads.current.clear();
    setSession(null);
  }

  return {
    appendFiles,
    beginSession,
    files,
    finishSession,
    removeFile,
    session,
    uploadFile,
  };
}

export async function uploadSelectedFile({
  selected,
  session,
  payloads,
  update,
  dependencies = defaultDependencies,
}: {
  selected: SelectedFile;
  session: UploadSession;
  payloads: UploadPayloadCache;
  update: (patch: Partial<SelectedFile>) => void;
  dependencies?: UploadDependencies;
}) {
  update({ progress: 0, error: undefined, attempt: undefined, maxAttempts: undefined });
  try {
    let attachment = payloads.get(selected.id);
    if (!attachment) {
      update({ phase: "encrypting" });
      attachment = await dependencies.encrypt(session.pasteKey, session.pasteId, selected.file);
      payloads.retain(selected.id, attachment);
    }
    update({ phase: "uploading" });
    await dependencies.upload(
      `/api/pastes/${session.pasteId}/files/${attachment.id}`,
      attachment.body,
      attachment.headers,
      {
        onProgress: (loaded, reportedTotal) => {
          const total = reportedTotal || attachment.body.byteLength;
          update({
            phase: "uploading",
            progress: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
          });
        },
        onRetry: (attempt, maxAttempts) => update({
          phase: "retrying",
          progress: 0,
          attempt,
          maxAttempts,
        }),
        confirmConflict: async () => {
          const attachments = await dependencies.list(session.pasteId);
          return attachments.some(({ id }) => id === attachment.id);
        },
      },
    );
    payloads.release(selected.id);
    update({ phase: "complete", progress: 100, attempt: undefined, maxAttempts: undefined });
    return true;
  } catch (cause) {
    update({ phase: "error", progress: 0, error: messageOf(cause) });
    return false;
  }
}

export async function discardUploadSession(
  pasteId: string,
  remove: (pasteId: string) => Promise<void> = async (id) => {
    await api<void>(`/api/pastes/${id}`, { method: "DELETE" });
  },
) {
  try {
    await remove(pasteId);
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
  }
}

export function createUploadPayloadCache() {
  const payloads = new Map<string, EncryptedAttachment>();
  return {
    get(id: string) {
      return payloads.get(id);
    },
    retain(id: string, payload: EncryptedAttachment) {
      payloads.set(id, payload);
    },
    release(id: string) {
      payloads.delete(id);
    },
    clear() {
      payloads.clear();
    },
    get size() {
      return payloads.size;
    },
  };
}
