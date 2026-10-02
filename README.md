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

## Status

This edition is the v1.0.0 source from private base `4978fa8`, synced and
reviewed on 2026-10-02; see [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md) for
the exact publication boundary and the public-edition differences. The v1.0.0
release was published on 2026-10-02: tag `v1.0.0` on `c3aaf32` and a
[GitHub Release](https://github.com/Blimp3/provenance-lens-extension/releases/tag/v1.0.0)
with the public ZIP attached (SHA-256
`627035ac41b91875769a35c25a90d2987bdfe6f6a23c8f4b94b475a0a826382e`). The owner
tags each release `vX.Y.Z` following
[docs/release-checklist.md](docs/release-checklist.md).

## Run locally

Use Node.js 24.20.0 and npm 11.6.2:

```sh
npm ci
npm run check
npm run test:e2e
npm run package:public
```

`npm run check` needs a git clone, because its source scan walks the tracked
files; it fails in a source ZIP or release archive.

The package command creates
`artifacts/provenance-lens-extension-v1.0.0-public.zip`. Load
`apps/extension/dist` as an unpacked extension for local review.

Fresh installs start in **Website review** mode. Lens downloads the exact
selected image and opens the fixed OpenAI Verify page for manual upload; it
does not submit to or scrape that page. API mode requires a backend URL and
client token supplied by the user plus an exact-origin browser permission. API
keys stay on that backend and are never stored in the extension.

## Optional DigiBot connection

The source retains the optional DigiBot integration: account pairing, image
Check and Download, and page-link delivery. Its public gateway URL and host
permission are configuration, not a secret or bearer. The extension makes no
DigiBot request on a fresh profile. Network use begins only after the user
starts pairing, or after an already paired profile resumes a pending
operation. Pairing still requires an admitted DigiBot account.

The popup lists its actions in this order: **Verify an image on this page**,
**Pick an image to download**, **Check audio or video segment** and, under the
**Send to Telegram as** dropdown, **Send this page's link to Telegram** and
**Pick a video on this page**. Download, the dropdown and the two link buttons
stay disabled until the browser is paired.

- **Send this page's link to Telegram** sends the current page address to the
  paired DigiBot, which downloads the media itself and posts it in your
  Telegram chat. The full page address, including any query parameters such as
  signed or private-link tokens, goes only to the connected DigiBot and is kept
  encrypted with the job; the fragment after `#` is not sent. Lens never
  fetches the video, this is delivery rather than verification, and the result
  is not in Lens History. A page without an http(s) address is refused before
  anything is sent; DigiBot's refusals and limit messages are shown as-is.
- **Send to Telegram as** chooses what DigiBot posts: **Video** (the default),
  **MP3**, or **Clip** with a Start and an End in whole seconds as `ss`, `m:ss`
  or `h:mm:ss`. A clip must start before it ends and stay within 24 hours; an
  invalid clip shows an inline error under the fields and sends nothing. MP3
  and Clip need DigiBot 5.0.0 or later.
- **Pick a video on this page** closes the popup and shows a picker on the
  page. It sends only the post's or video's own link that you click, with the
  same output choice: an X post is sent as its status link, and only while it
  shows a rendered video of its own; a YouTube card is pickable when its links
  name exactly one video; on any other site the nearest http(s) link is sent
  without its fragment. On X nothing but a post is ever sent, and a click on
  anything else sends nothing. The picker reads only the clicked post's or
  link's address, never the page's media, and the background checks that
  address again before sending it. Because the popup is closed, the outcome is
  a notice on the page and the toolbar badge. There is no right-click menu for
  videos; press Escape to cancel.

The synthetic browser tests intercept this gateway and do not call OpenAI,
Telegram, DigiBot, or a production verification backend. See
[docs/portfolio-demo.md](docs/portfolio-demo.md).

## Permissions

- `activeTab`, `contextMenus`, `scripting` and `storage` run the picker on the
  current tab after a direct user action, add the **Check OpenAI provenance**
  image context-menu entry, and keep settings and local results. `activeTab`
  also lets the opt-in **Verify a screenshot copy** fallback capture the
  visible tab; that fallback is off by default in Settings. `activeTab` also
  supplies the current page address to **Send this page's link to Telegram**
  when the popup opens, and `scripting` injects the video picker into the
  active page the same way as the image picker, so the link features add no
  permission.
- The one required host permission is the DigiBot gateway above. It grants no
  access to other sites.
- Optional `downloads` saves the exact selected file in Website review mode or
  the API manual fallback.
- Optional `http://*/*` and `https://*/*` let Lens retrieve a user-selected
  image from its host. **Grant optional access** in the popup or Settings asks
  the browser for site access and downloads at once; Settings can instead
  grant one exact origin, such as an image host or a user-controlled backend.

## Privacy and limits

- Verification starts only after a direct user action.
- The normal flow preserves and hashes exact selected bytes.
- Website mode creates no result history or verification cache entry.
- API and connected checks send the selected file to the backend the user
  explicitly configured or paired.
- Page-link delivery sends the page address or the picked link to the paired
  DigiBot and nothing else from the page; the video picker never reads the
  page's media.
- The background worker accepts the messages that start an action, resume a
  permission flow, verify a screenshot copy, fall back to a download or cancel
  the active check only from the extension's own pages, not from the page
  picker or other content scripts.
- Content Credentials and supported watermark evidence are provenance signals,
  not scene-truth or universal AI-detection claims.

## Licensing

Original Provenance Lens source in this edition is licensed under the MIT
License; see [LICENSE](LICENSE). This grant covers the project source and
documentation authored for Provenance Lens. Bundled third-party components
retain their own terms in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt);
the C2PA trust snapshot and test fixtures retain their notices beside those
files and are not relicensed by the project MIT grant.

The source edition derives from private repository base
`4978fa81dad8c13ee8ac5cff1512e0486e0fbcc0`. See
[SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md) for the exact publication boundary.
