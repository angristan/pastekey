import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type VerifyAuthenticationResponseOpts,
  type VerifyRegistrationResponseOpts,
} from "@simplewebauthn/server";

export function verifyAuthentication(options: VerifyAuthenticationResponseOpts) {
  return verifyAuthenticationResponse(options);
}

export function verifyRegistration(options: VerifyRegistrationResponseOpts) {
  return verifyRegistrationResponse(options);
}
