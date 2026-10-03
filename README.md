# Provenance Lens

Provenance Lens (Lens) is a Chromium extension for explicit, user-triggered
provenance checks. It checks images for Content Credentials, and images and
short audio for supported OpenAI provenance signals. A missing signal is not
proof that media is human-made or free from other AI involvement.

## This edition

This repository is the credential-free public source edition. It contains:

- the Lens extension
- shared validation and contracts
- deterministic fixtures
- local build and test tools

It does not contain:

- the private verification server
- the Cloudflare Worker and its bindings
- migrations
- owner provisioning
- environment files
- operational history
- historical release assets

## Verification modes

A fresh install starts in **Website review** mode. In this mode, Lens:

1. downloads the exact selected image
2. opens the fixed OpenAI Verify page for manual upload

Lens does not submit to that page and does not scrape it.

API mode needs three things:

- a backend URL that you supply
- a client token that you supply
- an exact-origin browser permission

API keys stay on that backend. Lens never stores them.

## Optional DigiBot connection

The source keeps the optional DigiBot integration. It has these features:

- account pairing
- image Check and Download
- page-link delivery

The DigiBot gateway URL is public. This URL and its host permission are
configuration, not a secret or a bearer token. On a fresh profile, Lens makes
no DigiBot request. Network use starts only in one of these cases:

- you start pairing
- a profile that is already paired resumes a pending operation

Pairing still needs an admitted DigiBot account.

### Popup actions

The popup shows its actions in this order:

1. **Verify an image on this page**
2. **Pick an image to download**
3. **Check audio or video segment**
4. **Send this page's link to Telegram**, under the **Send to Telegram as**
   dropdown
5. **Pick a video on this page**, under the same dropdown

Until you pair the browser, these controls stay disabled:

- **Pick an image to download**
- the **Send to Telegram as** dropdown
- **Send this page's link to Telegram**
- **Pick a video on this page**

### Send this page's link to Telegram

- Lens sends the current page address to the paired DigiBot. DigiBot downloads
  the media itself and posts it in your Telegram chat.
- The full page address goes only to the paired DigiBot. This address includes
  any query parameters, such as signed or private-link tokens. Lens does not
  send the fragment after `#`.
- DigiBot keeps the page address encrypted with the job.
- Lens never fetches the video. This feature is delivery, not verification.
  The result is not in Lens History.
- If the page does not have an http(s) address, Lens refuses the page before
  it sends anything.
- Lens shows the refusals and limit messages from DigiBot without changes.

### Send to Telegram as

The **Send to Telegram as** dropdown sets what DigiBot posts:

- **Video** (the default)
- **MP3**
- **Clip**, with a Start and an End in whole seconds as `ss`, `m:ss` or
  `h:mm:ss`

A clip must start before it ends. A clip must stay within 24 hours. If a clip
is not valid, an inline error shows under the fields and Lens sends nothing.
MP3 and Clip need DigiBot 5.0.0 or later.

### Pick a video on this page

**Pick a video on this page** closes the popup and shows the video picker on
the page. The video picker sends only the link of the post or video that you
click. It uses the same **Send to Telegram as** choice. The rules for each site
are:

- **X**: Lens sends a post as its status link. It does this only while the post
  shows a rendered video of its own. On X, Lens never sends anything but a post.
  A click on anything else sends nothing.
- **YouTube**: you can pick a card when its links name exactly one video.
- **Other sites**: Lens sends the nearest http(s) link without its fragment.

The video picker reads only the address of the clicked post or link. It never
reads the media on the page. The background worker checks that address again
before it sends the address.

The popup is closed, so Lens shows the outcome as a notice on the page and on
the toolbar badge. There is no right-click menu for videos. To cancel, press
Escape.

## Requirements

- Node.js 24.20.0
- npm 11.6.2
- a git clone of this repository for `npm run check`

`npm run check` needs a git clone because its source scan walks the tracked
files. If you use a source ZIP or a release archive, `npm run check` fails.

## Build and test

Run these commands in the repository root:

```sh
npm ci
npm run check
npm run test:e2e
npm run package:public
```

`npm run package:public` creates
`artifacts/provenance-lens-extension-v1.0.0-public.zip`.

The synthetic browser tests intercept the DigiBot gateway. They do not call
OpenAI, Telegram, DigiBot, or a production verification backend. See
[docs/portfolio-demo.md](docs/portfolio-demo.md).

For local review, load `apps/extension/dist` as an unpacked extension.

## Permissions

- `activeTab`, `contextMenus`, `scripting` and `storage` do these tasks:
  - run the image picker on the current tab after a direct user action
  - add the **Check OpenAI provenance** entry to the image context menu
  - keep settings and local results
- `activeTab` also lets the opt-in **Verify a screenshot copy** fallback
  capture the visible tab. This fallback is off by default in Settings.
- `activeTab` also gives the current page address to **Send this page's link
  to Telegram** when the popup opens.
- `scripting` injects the video picker into the active page in the same way as
  the image picker.
- Because of these two uses of `activeTab` and `scripting`, the link features
  add no permission.
- The only required host permission is the DigiBot gateway. It gives no access
  to other sites.
- The optional `downloads` permission saves the exact selected file in Website
  review mode or in the manual fallback of API mode.
- The optional `http://*/*` and `https://*/*` permissions let Lens get an image
  that you select from its host.
- **Grant optional access**, in the popup or in Settings, asks the browser for
  site access and downloads at the same time.
- As an alternative, Settings can grant one exact origin, such as an image host
  or a backend that you control.

## Privacy and limits

- Verification starts only after a direct user action.
- The normal flow keeps and hashes the exact selected bytes.
- Website review mode creates no result history and no verification cache
  entry.
- API mode checks and connected checks through DigiBot send the selected file
  to the backend that you explicitly configured or paired.
- Page-link delivery sends the page address or the picked link to the paired
  DigiBot. It sends nothing else from the page. The video picker never reads
  the media on the page.
- Some messages start an action, resume a permission flow, verify a screenshot
  copy, fall back to a download or cancel the active check. The background
  worker accepts these messages only from the pages of Lens itself. It does not
  accept them from the pickers on the page or from other content scripts.
- Content Credentials and supported watermark evidence are provenance signals.
  They are not scene-truth claims or universal AI-detection claims.

## Release status

This edition is the v1.0.0 source from private base `4978fa8`. The sync and
review date is 2026-10-02. The full private base commit is
`4978fa81dad8c13ee8ac5cff1512e0486e0fbcc0`.
[SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md) gives the exact publication
boundary and the public-edition differences.

The owner published the v1.0.0 release on 2026-10-02:

- tag `v1.0.0` on `c3aaf32`
- a
  [GitHub Release](https://github.com/Blimp3/provenance-lens-extension/releases/tag/v1.0.0)
  with the public ZIP attached
- SHA-256 of the public ZIP:
  `627035ac41b91875769a35c25a90d2987bdfe6f6a23c8f4b94b475a0a826382e`

The owner tags each release `vX.Y.Z` with the procedure in
[docs/release-checklist.md](docs/release-checklist.md).

## Licensing

Original Provenance Lens source in this edition is licensed under the MIT
License. See [LICENSE](LICENSE). This grant covers the project source and
documentation authored for Provenance Lens.

Bundled third-party components retain their own terms in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). The C2PA (Coalition for
Content Provenance and Authenticity) trust snapshot and the test fixtures
retain their notices beside those files. The project MIT grant does not
relicense the C2PA trust snapshot or the test fixtures.
