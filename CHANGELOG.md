# Changelog

## Unreleased public source edition

- Add a credential-free, public-only extension build and ZIP path.
- Default API configuration to a reserved non-routable example host and require
  explicit exact-origin permission for a user-controlled backend.
- Preserve the optional DigiBot pairing flow as an explicit opt-in without
  bundling an account credential.
- Include deterministic unit/browser checks and notices for bundled third-party
  software.
- Scan every tracked file in `npm run check` for local user-directory paths,
  provider-key-shaped strings and `workers.dev` hosts other than the DigiBot
  gateway.

## 0.8.0 source feature set

- Image Content Credentials and supported OpenAI provenance checks.
- Short-audio provenance checks with bounded format, size, and duration rules.
- Manual Website review, exact-byte picker behavior, local history/cache, and
  optional account-scoped DigiBot Check/Download workflows.
