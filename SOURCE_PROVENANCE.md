# Source provenance and publication boundary

This public source edition derives from private repository base
`91775e52e2d282e2c2280143a257fcdd5e44a9f8` (untagged, package version 0.8.0),
plus the public packaging changes reviewed on 2026-09-17. It was published as
this repository's first commit, `d0b453a`, on 2026-09-18. Later changes are
commits in this repository; the private repository's history is not part of
it. Public releases are tagged `vX.Y.Z` and listed on this repository's GitHub
Releases page; see [docs/release-checklist.md](docs/release-checklist.md).

Included:

- `apps/extension`: Chromium extension source, static pages, deterministic
  fixtures, unit tests, and browser tests;
- `packages/shared`: runtime schemas, validation, exact-byte hashing,
  provenance wording, test fixtures, and their existing licenses/notices;
- root build, lint, typecheck, test, public-package, local-launcher, and CI
  configuration;
- `docs`: the local portfolio demo and the public release checklist;
- the project MIT license in `LICENSE`;
- exact third-party notices for the 14 packages bundled into extension code.

Excluded:

- the private repository's Git history, branches, issues, releases, and
  historical ZIPs;
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

`SOURCE_MANIFEST.sha256` lists the SHA-256 of every tracked file except
itself. Regenerate it whenever a tracked file changes, with the command in the
[release checklist](docs/release-checklist.md), and check it with
`shasum -a 256 -c --quiet SOURCE_MANIFEST.sha256`.
