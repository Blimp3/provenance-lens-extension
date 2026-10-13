# Changelog

## [Unreleased]

### Changed

- Connected DigiBot requests stop after 30 s, and the wait for an operation
  status stops after 60 s. Before, a request or status wait that got no answer
  did not stop.
- When the last status request reaches the 60 s limit, Lens shows the latest
  status and says that the check is still processing. It does not show a
  timeout error.
- Only the upload deadline changes with the file size. It is at least 120 s,
  or 1 s for each 64 KiB of the file if that is longer.
- **Stop waiting** replaces **Cancel verification** while a connected image
  action runs. It stops the wait during operation creation, upload, status
  polling and the response read, and removes the local pending state. DigiBot
  can still finish a request that it accepted, and the result then shows in
  History.
- A blob context-menu image opens the picker to select the image again.

### Fixed

- **Stop waiting** during a token refresh stops at once, with no error toast.
  The refresh continues with its own 30 s deadline, and Lens always saves the
  new tokens.
- A stop during image retrieval shows "Stopped before anything was sent." for
  Verify and for Download.
- Explicitly saved loopback backend URLs (`127.0.0.1`, `localhost` or `[::1]`)
  stay unchanged. Only a legacy settings record with exactly
  `http://127.0.0.1:8787` and no client token changes to the default backend
  URL.

### Security and privacy

- Lens reads DigiBot JSON responses with a size limit: 4 MiB for History and
  1 MiB for all other responses.
- Video URLs for audio-segment checks do not include the URL fragment. This
  applies to the audio page prefill, the outbox and the segment request. Lens
  also removes the fragment from old outbox entries before it sends them again.
  The audio page says that the query string goes with the video URL.
- Dependency updates for security advisories: music-metadata 11.16.1
  (CVE-2026-107391, CVE-2026-107389), sharp 0.35.5 (CVE-2026-96889) and
  source-map-js 1.2.2 (CVE-2026-93749).

## [1.0.0] - 2026-10-02

First public source release. The extension and shared code are the private
edition's 1.0.0 (base `4978fa8`), with only the public-edition differences
recorded in [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md).

### Added

- Popup: **Send this page's link to Telegram** sends the current page address
  to the paired DigiBot, which delivers the download in your Telegram chat;
  Lens never fetches the video and needs no new permission. The full address,
  including query parameters, goes only to the connected DigiBot, which keeps
  it encrypted with the job; the fragment is not sent.
- Popup: a **Send to Telegram as** dropdown picks **Video** (default), **MP3**
  or **Clip** with whole-second Start and End times up to 24 hours; an invalid
  clip shows an inline error and sends nothing. MP3 and Clip need DigiBot 5.0.0
  or later.
- Popup: **Pick a video on this page** sends only a picked post's or video's
  own link: an X post with a rendered video as its status link, a YouTube card
  naming one video, or elsewhere the nearest http(s) link without its fragment.
- Shared: the link-download options schema and DigiBot's gateway contract
  fixture, a pinned byte-for-byte copy checked against the Lens schemas,
  including the link-download case.

### Changed

- Popup: **Verify an image on this page** (renamed from **Pick an image on this
  page**) is the first action, above **Pick an image to download**.
- A connected image Check shows its verdict once DigiBot saves the evidence,
  before the Telegram archive finishes.

### Fixed

- The image and audio-file actions keep the outbox bytes until DigiBot stops
  awaiting the upload, so a later resume can still upload them.

### Security and privacy

- The background worker accepts the messages that start an action, resume a
  permission flow, verify a screenshot copy, fall back to a download or cancel
  the active check only from the extension's own pages, not from the page
  picker or other content scripts.
- DigiBot answers for another operation, account or media are rejected, and
  the pending entry and outbox are cleaned up.

### Tests

- Unit tests cover the connected image and audio actions, DigiBot pairing and
  the session lifecycle, the History page, the page-link action, the output
  dropdown and the video picker; the kept outbox bytes are compared exactly.
  The connected browser flow also sends a page link.

### Public edition

- Version 1.0.0 everywhere; the package command creates
  `artifacts/provenance-lens-extension-v1.0.0-public.zip`.
- Add a credential-free, public-only extension build and ZIP path.
- Default API configuration to a reserved non-routable example host and require
  explicit exact-origin permission for a user-controlled backend.
- Preserve the optional DigiBot pairing flow as an explicit opt-in without
  bundling an account credential.
- Include deterministic unit/browser checks and notices for bundled third-party
  software.
- Scan every tracked file except the scanner's own test in `npm run check` for
  local user-directory paths, provider-key-shaped strings and `workers.dev`
  hosts other than the DigiBot gateway.
- `npm ci` refuses a Node.js version outside the engines range, and
  `npm run check` fails when the version differs anywhere.

## 0.8.0 source feature set

- Image Content Credentials and supported OpenAI provenance checks.
- Short-audio provenance checks with bounded format, size, and duration rules.
- Manual Website review, exact-byte picker behavior, local history/cache, and
  optional account-scoped DigiBot Check/Download workflows.
