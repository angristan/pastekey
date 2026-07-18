# Pastekey

A passkey-native, end-to-end encrypted pastebin built on Cloudflare Workers, D1, React, and Kumo.

## Security model

Pastekey encrypts and decrypts in the browser. Assuming the delivered JavaScript is trusted, the Worker and D1 never receive plaintext or usable decryption keys.

```text
Passkey PRF ──HKDF──> passkey wrapping key
                         │ unwraps
                         ▼
                   account key
                         │ unwraps
                         ▼
                 per-paste random key ──AES-GCM──> paste
                         │
                         └── wrapped by a share key from the URL #fragment
```

- Every paste gets an independent random AES-256-GCM key.
- The account key is wrapped independently for each passkey using WebAuthn PRF output.
- The title, format, and content are encrypted together.
- Share links contain a random secret after `#`; URL fragments are not sent to the server.
- Revoking a share deletes its wrapped paste-key envelope. It cannot revoke plaintext already copied by a recipient.
- D1 still exposes metadata: account/paste counts, timestamps, approximate ciphertext sizes, expiry, and access metadata.
- Losing every passkey means losing the vault. There is no server-side reset in this version.

## Stack

- Cloudflare Worker + Hono API
- Cloudflare D1
- React + Vite + Cloudflare Vite plugin
- Cloudflare Kumo components
- SimpleWebAuthn server verification
- Browser WebCrypto only for content encryption

## Develop

Requirements: Bun and a browser/passkey provider supporting the WebAuthn PRF extension.

```bash
bun install
bun run db:migrate:local
bun run dev
```

WebAuthn works on `localhost`. The local D1 database is stored under `.wrangler/`.

## Deploy

Create a D1 database, put its `database_id` in `wrangler.jsonc`, configure your route, `RP_ID`, and `ORIGIN`, then deploy:

```bash
bunx wrangler d1 create pastekey
bun run db:migrate:remote
bun run deploy
```

This repository is configured for `paste.stanislas.cloud`; forks must use their own D1 database and domain. Once passkeys exist for an RP ID, changing it requires registering new credentials.

## Commands

```bash
bun run dev
bun run typecheck
bun run test
bun run build
bun run db:migrate:local
```
