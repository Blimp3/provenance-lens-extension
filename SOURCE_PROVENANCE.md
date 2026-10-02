# Source provenance and publication boundary

This public source edition derives from private repository base
`4978fa81dad8c13ee8ac5cff1512e0486e0fbcc0` (untagged, package version 1.0.0),
reviewed for publication on 2026-10-02. The edition was first published from
private base `91775e5` (package version 0.8.0) as this repository's first
commit, `d0b453a`, on 2026-09-18, and synced to the 1.0.0 base on 2026-10-02.
Later changes are commits in this repository; the private repository's history
is not part of it. Public releases are tagged `vX.Y.Z` and listed on this
repository's GitHub Releases page; see
[docs/release-checklist.md](docs/release-checklist.md).

Sync status on 2026-10-02: v1.0.0 source from private base `4978fa8`. The
included paths below match that base except for the public-edition differences
listed at the end and three comments in `packages/shared/tests`, which name no
private pull request or private repository path. Compared with the 0.8.0
source, the sync brings the popup order and the background's extension-page-only
message gate, the connected-check fixes, the **Send this page's link to
Telegram** button with its **Send to Telegram as** dropdown, the **Pick a video
on this page** picker, the link-download options and the DigiBot gateway
contract fixture; the [CHANGELOG](CHANGELOG.md) describes each by its effect
for users.

Included:

- `apps/extension`: Chromium extension source, static pages, deterministic
  fixtures, unit tests, and browser tests;
- `packages/shared`: runtime schemas, validation, exact-byte hashing,
  provenance wording, test fixtures, and their existing licenses/notices;
- root build, lint, typecheck, test, tracked-source scan, version-sync,
  public-package, local-launcher, and CI configuration;
- `CLAUDE.md`, the contributor guide for this edition;
- `docs`: the local portfolio demo and the public release checklist;
- the project MIT license in `LICENSE`;
- exact third-party notices for the 14 packages bundled into extension code,
  which `npm run check` compares with the esbuild bundle.

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
- the optional DigiBot gateway remains because pairing and page-link delivery
  are public product features. Its URL is not a credential, and a fresh profile
  makes no request;
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
