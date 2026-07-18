import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { api, jsonBody } from "./api";
import {
  derivePasskeyWrappingKey,
  fromBase64Url,
  generateAccountKey,
  PRF_INPUT,
  toBase64Url,
  unwrapAccountKey,
  wrapAccountKey,
} from "./crypto";
import type { AuthSuccess } from "./types";

type PrfOutputs = {
  prf?: {
    enabled?: boolean;
    results?: { first?: ArrayBuffer; second?: ArrayBuffer };
  };
};

export async function registerPasskey(existingAccountKey?: CryptoKey) {
  assertPasskeySupport();
  const endpoint = existingAccountKey ? "/api/auth/passkeys/options" : "/api/auth/register/options";
  const options = await api<PublicKeyCredentialCreationOptionsJSON>(endpoint, { method: "POST" });
  const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("Passkey creation was canceled");

  const prfOutput = getPrfOutput(credential);
  const accountKey = existingAccountKey ?? (await generateAccountKey());
  const passkeyKey = await derivePasskeyWrappingKey(prfOutput);
  const wrappedAccountKey = await wrapAccountKey(accountKey, passkeyKey, credential.id);
  const result = await api<AuthSuccess>("/api/auth/register/verify", {
    method: "POST",
    ...jsonBody({ credential: registrationJSON(credential), wrappedAccountKey }),
  });

  return { accountKey, auth: result };
}

export async function unlockWithPasskey() {
  assertPasskeySupport();
  const options = await api<PublicKeyCredentialRequestOptionsJSON>("/api/auth/login/options", { method: "POST" });
  const credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("Passkey sign-in was canceled");

  const prfOutput = getPrfOutput(credential);
  const auth = await api<AuthSuccess>("/api/auth/login/verify", {
    method: "POST",
    ...jsonBody({ credential: authenticationJSON(credential) }),
  });
  const passkeyKey = await derivePasskeyWrappingKey(prfOutput);
  const accountKey = await unwrapAccountKey(auth.wrappedAccountKey, passkeyKey, auth.credentialId);
  return { accountKey, auth };
}

function assertPasskeySupport() {
  if (!window.isSecureContext || !("PublicKeyCredential" in window)) {
    throw new Error("Passkeys require a modern browser in a secure context");
  }
}

function getPrfOutput(credential: PublicKeyCredential) {
  const extensions = credential.getClientExtensionResults() as PrfOutputs;
  const output = extensions.prf?.results?.first;
  if (!output) {
    throw new Error("This passkey provider does not support encrypted vaults (WebAuthn PRF)");
  }
  return output;
}

function creationOptions(options: PublicKeyCredentialCreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    user: { ...options.user, id: fromBase64Url(options.user.id) },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: fromBase64Url(credential.id),
    })),
    extensions: {
      ...options.extensions,
      prf: { eval: { first: PRF_INPUT } },
    },
  } as PublicKeyCredentialCreationOptions;
}

function requestOptions(options: PublicKeyCredentialRequestOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    allowCredentials: options.allowCredentials?.map((credential) => ({
      ...credential,
      id: fromBase64Url(credential.id),
    })),
    extensions: {
      ...options.extensions,
      prf: { eval: { first: PRF_INPUT } },
    },
  } as PublicKeyCredentialRequestOptions;
}

function registrationJSON(credential: PublicKeyCredential): RegistrationResponseJSON {
  const response = credential.response as AuthenticatorAttestationResponse;
  const futureResponse = response as AuthenticatorAttestationResponse & {
    getTransports?: () => AuthenticatorTransport[];
  };
  return {
    id: credential.id,
    rawId: toBase64Url(new Uint8Array(credential.rawId)),
    response: {
      clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
      attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
      transports: futureResponse.getTransports?.() as RegistrationResponseJSON["response"]["transports"],
    },
    authenticatorAttachment: (credential.authenticatorAttachment ?? undefined) as RegistrationResponseJSON["authenticatorAttachment"],
    clientExtensionResults: {},
    type: "public-key",
  };
}

function authenticationJSON(credential: PublicKeyCredential): AuthenticationResponseJSON {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(new Uint8Array(credential.rawId)),
    response: {
      clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
      authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
      signature: toBase64Url(new Uint8Array(response.signature)),
      ...(response.userHandle ? { userHandle: toBase64Url(new Uint8Array(response.userHandle)) } : {}),
    },
    authenticatorAttachment: (credential.authenticatorAttachment ?? undefined) as AuthenticationResponseJSON["authenticatorAttachment"],
    clientExtensionResults: {},
    type: "public-key",
  };
}
