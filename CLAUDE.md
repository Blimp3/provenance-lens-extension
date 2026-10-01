# Provenance Lens public edition

Credential-free public source edition of the Provenance Lens Chromium MV3
extension. This repository is public: everything committed here is published.
This guide is written for this edition; don't replace it with another
repository's guide.

## Layout

- `apps/extension/`: extension source, static pages, unit tests (Vitest and
  jsdom) and browser tests (Playwright).
- `packages/shared/`: schemas, validation, exact-byte hashing, provenance
  wording and integration contracts.
- `scripts/`: manifest audit, built-extension scan, tracked-source scan, ZIP
  packaging and the local launcher.

## Commands

Use Node.js 24.20.0 (`.nvmrc`) and npm 11.6.2. In a cloud session, prepend
`/opt/node24/bin` to `PATH` first.

```sh
npm ci
npm run check            # format, lint, typecheck, unit tests, build, source scan
npm run test:e2e         # Playwright browser tests (needs Chromium)
npm run package:public   # manifest audit, built-extension scan, ZIP
```

Run all three before calling work done; CI runs the same steps.

## Publication boundary

- [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md) defines what belongs here and
  [docs/release-checklist.md](docs/release-checklist.md) is the release
  procedure.
- Never add server or Worker code, Cloudflare bindings or migrations,
  provisioning or deployment scripts, `.env*`, `.dev.vars*`,
  `.bundled-client.json`, tokens or API keys, owner data, local machine paths,
  private hostnames or operational evidence.
- The only allowed `workers.dev` host is the documented DigiBot gateway that
  `scripts/scan-extension.mjs` and `scripts/audit-extension.mjs` already list.
- Every pull request that changes a tracked file regenerates
  `SOURCE_MANIFEST.sha256` as its last change, with the command in step 6 of
  the release checklist (stage new files first).

## Extension invariants

- **User-triggered only.** Checks, page access and network requests start only
  from a direct user action, or resume one the user already started. No
  persistent content scripts; a fresh profile makes no DigiBot request.
- **Exact bytes.** Validate, hash and send the exact selected bytes. Never
  silently re-encode, resize or substitute them; the screenshot copy is a
  separate opt-in fallback and stays labelled as one.
- **`not_detected` is never proof.** A missing Content Credential or watermark
  signal does not show that media is human-made or free of AI involvement;
  keep the wording that says so.
- **Document every permission.** A manifest permission or host-pattern change
  needs its user-facing reason in `README.md` and an exact update to the lists
  in `scripts/audit-extension.mjs`, which rejects anything else.
