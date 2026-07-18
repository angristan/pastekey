# Pastekey

Passkey-native, end-to-end encrypted text and file sharing built on Cloudflare Workers, D1, React, and Kumo.

## Security model

Pastekey encrypts and decrypts in the browser. Assuming the delivered JavaScript is trusted, the Worker and D1 never receive plaintext or usable decryption keys.

```text
Passkey PRF ──HKDF──> passkey wrapping key
                         │ unwraps
                         ▼
                   account key
                         │ unwraps
                         ▼
                  per-item random key ──AES-GCM──> paste or file drop
                         │
                         ├── wraps independent file keys ──AES-GCM──> R2 ciphertext
                         └── wrapped by a share key from the URL #fragment
```

- Every paste or standalone file drop gets an independent random AES-256-GCM key.
- The account key is wrapped independently for each passkey using WebAuthn PRF output.
- Item type, title, format, and text content are encrypted together; legacy pastes remain compatible.
- Every file has an independent key; filename, MIME type, and bytes are encrypted locally before R2 upload.
- Raster images, audio, video, and text can be decrypted for an on-demand local preview; active HTML, SVG, XML, and unknown formats are never embedded.
- Share links contain a random secret after `#`; URL fragments are not sent to the server. A new link is shown for copying only in the browser session that created it.
- Revoking a share deletes its wrapped paste-key envelope. It cannot revoke plaintext already copied by a recipient.
- Account deletion immediately revokes sessions and shares, then a durable Workflow removes R2 ciphertext in bounded retryable batches before deleting account metadata.
- D1 and R2 still expose metadata: account/paste/file counts, timestamps, ciphertext sizes, expiry, and access metadata.
- Analytics Engine records only fixed operation names, outcomes, coarse encrypted-file size buckets, duration, and HTTP status. It never receives paths, identifiers, IP addresses, filenames, or content.
- Losing every passkey means losing the vault. There is no server-side reset in this version.

## Stack

- Cloudflare Worker + Hono API
- Cloudflare D1 metadata + R2 encrypted attachment storage
- Workers Rate Limiting + Turnstile registration protection
- Workers Analytics Engine for identifier-free product and reliability metrics
- Cloudflare Queues for retryable routine ciphertext deletion
- An actively consumed dead-letter queue with exponential retry cycles capped at once per day
- Cloudflare Workflows for durable account deletion
- Hourly expiry cleanup backed by a transactional D1 deletion outbox
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
│   └── sharing/         # Public shared paste and file-drop experience
└── lib/                 # Stable API surface, API client, downloads, formatting, protocol types

worker/
├── routes/              # Auth, paste, attachment, and sharing HTTP boundaries
├── middleware/          # Cross-cutting request policy
├── repositories/        # D1/R2 persistence adapters
├── services/            # Sessions, Turnstile, queued retention cleanup
├── workflows/           # Durable multi-step account deletion
├── lib/                 # Validation, encoding, and configuration
└── index.ts             # Composition root only
```

Cryptography and wire-format types remain independent of React. Worker routes own HTTP concerns while reusable infrastructure stays outside route modules. Analytics uses a fixed, identifier-free schema documented in `worker/middleware/analytics.ts`. Tests run inside the Workers runtime with isolated D1 and R2 bindings; the attachment suite exercises the authenticated upload, list, download, and cleanup lifecycle end to end.

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
bunx wrangler queues create pastekey-deletions
bunx wrangler queues create pastekey-deletions-dlq
bunx wrangler secret put TURNSTILE_SECRET_KEY
bun run db:migrate:remote
bun run deploy
```

The Turnstile site key is a public `vars` value; its secret must only be stored with `wrangler secret put`. Default quotas are 100 encrypted items, 10 files per item, 25 MiB per file, and 100 MiB of files per account.

This repository is configured for `paste.stanislas.cloud`; forks must use their own D1 database and domain. Once passkeys exist for an RP ID, changing it requires registering new credentials.

## Commands

```bash
bun run dev
bun run typecheck
bun run test
bun run build
bun run db:migrate:local
```
