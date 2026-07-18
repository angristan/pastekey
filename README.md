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
                         ├── wraps independent attachment keys ──AES-GCM──> R2 ciphertext
                         └── wrapped by a share key from the URL #fragment
```

- Every paste gets an independent random AES-256-GCM key.
- The account key is wrapped independently for each passkey using WebAuthn PRF output.
- The title, format, and content are encrypted together.
- Every attachment has an independent key; filename, MIME type, and bytes are encrypted locally before R2 upload.
- Share links contain a random secret after `#`; URL fragments are not sent to the server.
- Revoking a share deletes its wrapped paste-key envelope. It cannot revoke plaintext already copied by a recipient.
- D1 and R2 still expose metadata: account/paste/file counts, timestamps, ciphertext sizes, expiry, and access metadata.
- Losing every passkey means losing the vault. There is no server-side reset in this version.

## Stack

- Cloudflare Worker + Hono API
- Cloudflare D1 metadata + R2 encrypted attachment storage
- Workers Rate Limiting + Turnstile registration protection
- Hourly cleanup for expired D1 records and R2 objects
- React + Vite + Cloudflare Vite plugin
- Cloudflare Kumo components
- SimpleWebAuthn server verification
- Browser WebCrypto only for content encryption

## Architecture

```text
src/
├── components/          # Shared presentation, including attachment rows
├── crypto/              # Account, paste/share, attachment protocols and primitives
├── features/
│   ├── auth/            # Landing, locked state, Turnstile
│   ├── pastes/          # Dashboard, composer, paste management
│   └── sharing/         # Public shared-paste experience
└── lib/                 # Stable API surface, API client, downloads, formatting, protocol types

worker/
├── routes/              # Auth, paste, attachment, and sharing HTTP boundaries
├── middleware/          # Cross-cutting request policy
├── repositories/        # D1/R2 persistence adapters
├── services/            # Sessions, Turnstile, retention cleanup
├── lib/                 # Validation, encoding, and configuration
└── index.ts             # Composition root only
```

Cryptography and wire-format types remain independent of React. Worker routes own HTTP concerns while reusable infrastructure stays outside route modules. Tests run inside the Workers runtime with isolated D1 and R2 bindings; the attachment suite exercises the authenticated upload, list, download, and cleanup lifecycle end to end.

## Develop

Requirements: Bun and a browser/passkey provider supporting the WebAuthn PRF extension.

```bash
bun install
bun run db:migrate:local
bun run dev
```

WebAuthn works on `localhost`. The local D1 database is stored under `.wrangler/`.

## Deploy

Create D1 and R2 resources, put their bindings in `wrangler.jsonc`, configure your route, WebAuthn RP, limits, and Turnstile widget, then deploy:

```bash
bunx wrangler d1 create pastekey
bunx wrangler r2 bucket create pastekey-files
bunx wrangler secret put TURNSTILE_SECRET_KEY
bun run db:migrate:remote
bun run deploy
```

The Turnstile site key is a public `vars` value; its secret must only be stored with `wrangler secret put`. Default quotas are 100 pastes, 10 files per paste, 25 MiB per file, and 100 MiB of attachments per account.

This repository is configured for `paste.stanislas.cloud`; forks must use their own D1 database and domain. Once passkeys exist for an RP ID, changing it requires registering new credentials.

## Commands

```bash
bun run dev
bun run typecheck
bun run test
bun run build
bun run db:migrate:local
```
