import { useEffect, useRef, useState } from "react";

import type { StoredAttachment } from "../../../shared/protocol/attachments";
import { api } from "../../lib/api";
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

  async function uploadFile(selected: SelectedFile, uploadSession: UploadSession) {
    updateFile(selected.id, { progress: 0, error: undefined, attempt: undefined, maxAttempts: undefined });
    try {
      let attachment = payloads.current.get(selected.id);
      if (!attachment) {
        updateFile(selected.id, { phase: "encrypting" });
        attachment = await encryptAttachment(uploadSession.pasteKey, uploadSession.pasteId, selected.file);
        payloads.current.retain(selected.id, attachment);
      }
      updateFile(selected.id, { phase: "uploading" });
      await uploadWithRetry(
        `/api/pastes/${uploadSession.pasteId}/files/${attachment.id}`,
        attachment.body,
        attachment.headers,
        {
          onProgress: (loaded, reportedTotal) => {
            const total = reportedTotal || attachment.body.byteLength;
            updateFile(selected.id, {
              phase: "uploading",
              progress: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
            });
          },
          onRetry: (attempt, maxAttempts) => updateFile(selected.id, {
            phase: "retrying",
            progress: 0,
            attempt,
            maxAttempts,
          }),
          confirmConflict: async () => {
            const result = await api<{ attachments: StoredAttachment[] }>(
              `/api/pastes/${uploadSession.pasteId}/files`,
            );
            return result.attachments.some(({ id }) => id === attachment.id);
          },
        },
      );
      payloads.current.release(selected.id);
      updateFile(selected.id, { phase: "complete", progress: 100, attempt: undefined, maxAttempts: undefined });
      return true;
    } catch (cause) {
      updateFile(selected.id, { phase: "error", progress: 0, error: messageOf(cause) });
      return false;
    }
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
