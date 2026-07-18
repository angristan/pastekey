import { describe, expect, it } from "vitest";

import { analyticsOperation } from "./analytics";

describe("Analytics Engine operation classification", () => {
  it.each([
    ["POST", "/api/auth/register/options", "auth_register_options"],
    ["POST", "/api/auth/register/verify", "auth_register_verify"],
    ["POST", "/api/auth/login/options", "auth_login_options"],
    ["POST", "/api/auth/login/verify", "auth_login_verify"],
    ["POST", "/api/auth/passkeys/options", "passkey_add_options"],
    ["DELETE", "/api/auth/passkeys/secret-credential-id", "passkey_remove"],
    ["POST", "/api/pastes", "item_create"],
    ["PUT", "/api/pastes/secret-item-id", "item_update"],
    ["DELETE", "/api/pastes/secret-item-id", "item_delete"],
    ["PUT", "/api/pastes/secret-item-id/files/secret-file-id", "file_upload"],
    ["DELETE", "/api/pastes/secret-item-id/files/secret-file-id", "file_remove"],
    ["GET", "/api/pastes/secret-item-id/files/secret-file-id/content", "file_download"],
    ["POST", "/api/pastes/secret-item-id/shares", "share_create"],
    ["DELETE", "/api/pastes/secret-item-id/shares/secret-share-id", "share_revoke"],
    ["GET", "/api/shares/secret-share-id", "share_open"],
    ["GET", "/api/shares/secret-share-id/files/secret-file-id/content", "shared_file_download"],
  ])("classifies %s %s without retaining identifiers", (method, pathname, operation) => {
    expect(analyticsOperation(method, pathname)).toBe(operation);
    expect(operation).not.toContain("secret");
  });

  it.each([
    ["GET", "/api/health"],
    ["GET", "/api/config"],
    ["GET", "/api/auth/me"],
    ["GET", "/api/pastes"],
    ["GET", "/unknown"],
  ])("does not record routine request %s %s", (method, pathname) => {
    expect(analyticsOperation(method, pathname)).toBeNull();
  });
});
