# Provenance Lens

Provenance Lens is a Chromium extension for explicit, user-triggered checks of
image Content Credentials and supported OpenAI image or short-audio provenance
signals. A missing signal is not proof that media is human-made or free from
other AI involvement.

This is the credential-free public source edition. It contains the extension,
shared validation/contracts, deterministic fixtures, and local build/test
tools. It excludes the private verification server, Cloudflare Worker and
bindings, migrations, owner provisioning, environment files, operational
history, and historical release assets.

## Run locally

Use Node.js 24.20.0 and npm 11.6.2:

```sh
npm ci
npm run check
npm run test:e2e
npm run package:public
```

The package command creates
`artifacts/provenance-lens-extension-v0.8.0-public.zip`. Load
`apps/extension/dist` as an unpacked extension for local review.

Fresh installs start in **Website review** mode. Lens downloads the exact
selected image and opens the fixed OpenAI Verify page for manual upload; it
does not submit to or scrape that page. API mode requires a backend URL and
client token supplied by the user plus an exact-origin browser permission. API
keys stay on that backend and are never stored in the extension.

## Optional DigiBot connection

The source retains the optional v0.8 DigiBot integration. Its public gateway
URL and host permission are configuration, not a secret or bearer. The
extension makes no DigiBot request on a fresh profile. Network use begins only
after the user starts pairing, or after an already paired profile resumes a
pending operation. Pairing still requires an admitted DigiBot account.

The synthetic browser tests intercept this gateway and do not call OpenAI,
Telegram, DigiBot, or a production verification backend. See
[docs/portfolio-demo.md](docs/portfolio-demo.md).

## Privacy and limits

- Verification starts only after a direct user action.
- The normal flow preserves and hashes exact selected bytes.
- Website mode creates no result history or verification cache entry.
- API and connected checks send the selected file to the backend the user
  explicitly configured or paired.
- Content Credentials and supported watermark evidence are provenance signals,
  not scene-truth or universal AI-detection claims.

## Licensing

Original Provenance Lens source in this candidate is licensed under the MIT
License; see [LICENSE](LICENSE). This grant covers the project source and
documentation authored for Provenance Lens. Bundled third-party components
retain their own terms in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt);
the C2PA trust snapshot and test fixtures retain their notices beside those
files and are not relicensed by the project MIT grant.

The source edition derives from private repository base
`91775e52e2d282e2c2280143a257fcdd5e44a9f8`. See
[SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md) for the exact publication boundary.
