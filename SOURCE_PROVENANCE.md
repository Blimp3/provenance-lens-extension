# Source provenance and publication boundary

This public source candidate derives from private repository base
`91775e52e2d282e2c2280143a257fcdd5e44a9f8`, plus the locally reviewed public
packaging changes recorded on 2026-09-17. It has no Git metadata and no commit
was created.

Included:

- `apps/extension`: Chromium extension source, static pages, deterministic
  fixtures, unit tests, and browser tests;
- `packages/shared`: runtime schemas, validation, exact-byte hashing,
  provenance wording, test fixtures, and their existing licenses/notices;
- root build, lint, typecheck, test, public-package, local-launcher, and CI
  configuration;
- the project MIT license in `LICENSE`;
- exact third-party notices for the 14 packages bundled into extension code.

Excluded:

- `.git`, private branches/history, issues, releases, and historical ZIPs;
- `.env*`, `.dev.vars*`, `.bundled-client.json`, API keys, account/client
  bearers, cookies, media, databases, and operational data;
- `apps/server`, `apps/worker`, Cloudflare bindings/migrations, deployment and
  credential-provisioning scripts;
- owner-only runbooks and production-health or migration evidence.

Public-edition differences:

- the builder is public-only and never reads personal configuration;
- the verification backend default is the reserved non-routable
  `https://provenance-backend.example.invalid` placeholder;
- the production verification host permission is absent; a user-controlled
  backend requires explicit exact-origin permission;
- the optional DigiBot gateway remains because pairing is a public v0.8 product
  feature. Its URL is not a credential, and a fresh profile makes no request;
- the artifact scanner allows that documented gateway and rejects every other
  `workers.dev` hostname without retaining a private endpoint literal;
- the private backend/Worker workspaces, their tests, and all provisioning and
  deployment commands are absent;
- the project source is licensed under MIT as stated in `LICENSE`; third-party
  notices and file-specific terms do not extend that grant to those materials.

`SOURCE_MANIFEST.sha256` is generated after verification and is the exact
allowlist of files in the review candidate.
