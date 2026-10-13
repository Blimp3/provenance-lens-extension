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

## The Lens palette

The Lens palette replaces the toolbar popup. The palette is a search field and
a command list that opens over the current page. Opening the palette reads only
local extension storage. It starts no check and sends no network request.

You can open the palette in these ways:

- Press **Alt+Shift+Space** (**⌥⇧Space** on a Mac). The same key closes it.
- Click the Lens toolbar icon. A second click closes it.
- Right-click a page, a frame, selected text or an image, and choose **Open
  Lens palette**.
- Right-click a video or audio player, and choose **Lens palette for this
  video…**. This opens the Download view for the page.

The first view shows these rows:

- **Download**
- **Verify**
- **Clip**
- **Recent**
- **Settings**
- up to three commands that you ran recently, under **Last used**

If the browser did not assign the palette key, the row **Choose a palette
shortcut** opens the browser's shortcuts page. Type to search all commands. An
alias puts its command first. For example, `d` finds **Send video** and `v`
finds **Pick an image to verify…**. Use **Actions ⌘K** to set or clear an
alias.

Until a later release, these rows and buttons open the Settings page in a tab:

- the **Settings**, **Connect DigiBot** and **Needs download access** rows
- the toast buttons **Connect DigiBot**, **Grant access** and **Switch to API**

### Keys in the palette

| Key                                | Does                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| Typing                             | Filters the list                                                                   |
| ↑ / ↓, Ctrl+P / Ctrl+N             | Move the active row                                                                |
| ⌘↑ / ⌘↓                            | First or last row                                                                  |
| Enter                              | Run the row or open its view                                                       |
| Alt+1 … Alt+9 (⌥1 … ⌥9 on a Mac)   | Run or open row 1 to 9                                                             |
| ⌘K (Ctrl+K)                        | Open or close the action panel: Run, Set alias…, Clear alias, Set hotkey…          |
| Esc                                | Close the action panel, clear the search, go back one view, then close the palette |
| Backspace in an empty search field | Go back one view                                                                   |
| Tab / Shift+Tab                    | Move between the search field and **Actions ⌘K**; focus stays in the palette       |

These keys reach only the palette. The page under it does not get them. When
the palette closes, focus goes back to the page element that had it.

### Browser commands

The browser lists these commands on its shortcuts page,
`chrome://extensions/shortcuts` (in Brave, `brave://extensions/shortcuts`). You
can set or change each key there. Chromium gives extensions no way to set a key
themselves, so **Set hotkey…** opens that page.

| Command                                                     | Suggested key   | Does                                                   |
| ----------------------------------------------------------- | --------------- | ------------------------------------------------------ |
| Open or close the Lens palette                              | Alt+Shift+Space | Opens the palette, or closes it                        |
| Pick an image for OpenAI provenance review                  | Alt+Shift+V     | Starts the Verify picker, as before                    |
| Send this page's video to Telegram                          | None            | Sends the page link through DigiBot                    |
| Send this page's audio to Telegram as a voice note          | None            | The same, as a voice note                              |
| Send this page's audio to Telegram as an audio file         | None            | The same, as an audio file                             |
| Pick a post and send its video to Telegram                  | None            | Starts the post picker                                 |
| Pick a post and send its audio to Telegram as a voice note  | None            | The same, as a voice note                              |
| Pick a post and send its audio to Telegram as an audio file | None            | The same, as an audio file                             |
| Pick an image and send the original to Telegram             | None            | Starts the picker for a DigiBot download               |
| Cancel the running verification or pick                     | None            | Stops a running check, or a picker waiting for a click |
| Open the Lens palette at Clip                               | None            | Opens the Clip view                                    |

The commands other than the two palette commands run without the palette. They
report with a toast on the page and with the toolbar badge.

### Right-click menu

Page items show only on `http` and `https` pages. If two or more items apply,
the browser puts them under one **Provenance Lens** item.

| Right-click on                             | Item                                                                         | Does                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| An image                                   | **Verify this image**                                                        | Checks that image, as **Check OpenAI provenance** did                                                |
| An image                                   | **Send this image to Telegram**                                              | Sends the original file through DigiBot, or opens Settings to connect DigiBot                        |
| An image, a page, a frame or selected text | **Open Lens palette**                                                        | Opens the palette                                                                                    |
| A link                                     | **Send link to Telegram as video**, **…as voice note** or **…as audio file** | Sends that link through DigiBot. On X, right-click the post's timestamp                              |
| A video or audio player                    | **Send this video to Telegram**                                              | Sends the page link, or starts the post picker on an X or YouTube page that is not one post or video |
| A video or audio player                    | **Lens palette for this video…**                                             | Opens the Download view for this page                                                                |
| The toolbar icon                           | **Settings…**, **Recent results…** or **Result history**                     | Opens Settings, the palette at Recent, or the History page                                           |

### Restricted pages

Some pages do not allow the palette, for example `chrome://` and `brave://`
pages, the Web Store and pages that refuse it. On these pages, the same palette
opens as a popup under the toolbar icon. Page commands show **Not on browser
pages**. If the browser also refuses the popup, the palette opens in a tab.

### Why `palette.html` is web-accessible

`web_accessible_resources` lists only `palette.html`, and only for `http` and
`https` pages. This lets the palette show as a frame on the page where you
opened it. It is not a permission and gives no access to sites. If a page
embeds the file, the frame stays blank:

- The palette renders only with a single-use token. The service worker stores
  this token when you open the palette.
- The worker accepts commands from a palette frame only for the tab where it
  opened that palette.

### Google SynthID handoff

**Verify › Check with Google SynthID…** shows this note under the row: "Google
has no SynthID API yet, so Lens opens Google's SynthID Detector with your file.
Lens will check it directly once Google releases an API."

This check does not need DigiBot. Lens saves the exact bytes of the image that
you pick and opens Google's SynthID Detector in a new tab. You upload the file
there yourself. Lens uploads nothing to Google and keeps no history record or
cache entry for this check. The handoff needs the optional `downloads`
permission.

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
Lens migrates the legacy `http://127.0.0.1:8787` default only for an unmarked
settings record with no client token. Explicitly saved loopback backends stay
unchanged.

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

### Palette rows that need DigiBot

Until you pair the browser, these rows show **Needs DigiBot** and open
Settings:

- **Download › Send video**, **Send voice note**, **Send audio file** and
  **Send clip…**
- **Download › Pick a post → video…**, **Pick a post → voice note…**, **Pick a
  post → audio file…** and **Pick an image → Telegram…**
- **Verify › Verify audio of this page…**
- the rows of the **Clip** view

**Verify › Pick an image to verify…**, **Check with Google SynthID…** and
**Verify an audio file…** do not need DigiBot.

### Send video

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
- On an X or YouTube page that is not one post or video, **Send video**,
  **Send voice note** and **Send audio file** start the post picker instead.
- Lens shows the refusals and limit messages from DigiBot without changes.

### Video, audio or clip

The Download view sets what DigiBot posts:

- **Send video**
- **Send voice note**, an OGG/Opus voice note that plays in the chat
- **Send audio file**, an M4A with its title and music player
- **Send clip…**, which opens the Clip view. Type a range such as `1:30-2:10`,
  `1:30 2:10`, `90-130` or `1:02:03-1:05:00`. Each bound is `ss`, `m:ss` or
  `h:mm:ss`.

A clip must start before it ends. A clip must stay within 24 hours. If a range
is not valid, an inline error shows under the search field and Lens sends
nothing. Clip needs DigiBot 5.0.0 or later. **Send voice note** and **Send
audio file** need DigiBot's link route to accept the voice-note and M4A outputs;
DigiBot 5.0.0 accepts only MP3 and refuses them.

**Verify audio of this page…** and **Clip › Verify this clip's audio** check 1
to 60 seconds of the page's video through DigiBot. The check runs in the
background, and the page shows its progress and result as a notice.

### Pick a post

**Pick a post → video…**, **Pick a post → voice note…** or **Pick a post →
audio file…** closes the palette and
shows the video picker on the page. The video picker sends only the link of the
post or video that you click. The rules for each site are:

- **X**: Lens sends a post as its status link. It does this only while the post
  shows a rendered video of its own. On X, Lens never sends anything but a post.
  A click on anything else sends nothing.
- **YouTube**: you can pick a card when its links name exactly one video.
- **Other sites**: Lens sends the nearest http(s) link without its fragment.

The video picker reads only the address of the clicked post or link. It never
reads the media on the page. The background worker checks that address again
before it sends the address.

The palette is closed, so Lens shows the outcome as a notice on the page and on
the toolbar badge. To cancel, press Escape. You can also right-click a link and
choose **Send link to Telegram as video**, **…as voice note** or **…as audio
file**, or right-click a
video and choose **Send this video to Telegram**.

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
`artifacts/provenance-lens-extension-v2.0.0-public.zip`.

The synthetic browser tests intercept the DigiBot gateway. They do not call
OpenAI, Telegram, DigiBot, or a production verification backend. See
[docs/portfolio-demo.md](docs/portfolio-demo.md).

For local review, load `apps/extension/dist` as an unpacked extension.

## Permissions

- `activeTab`, `contextMenus`, `scripting` and `storage` do these tasks:
  - run the image picker on the current tab after a direct user action
  - add the Lens items to the right-click menu
  - keep settings and local results
- `activeTab` also lets the opt-in **Verify a screenshot copy** fallback
  capture the visible tab. This fallback is off by default in Settings.
- `activeTab` also gives the current page address to **Send video** and the
  other page-link rows when you open the palette.
- `scripting` injects the video picker into the active page in the same way as
  the image picker. It also adds the palette to the page where you open it.
- **Send video** and the other page-link rows also use `scripting` to inject
  that page runtime, which shows the send's progress and result as a toast on
  the page.
- Because of these uses of `activeTab` and `scripting`, the link features add
  no permission.
- The only required host permission is the DigiBot gateway. It gives no access
  to other sites.
- The optional `downloads` permission saves the exact selected file in Website
  review mode, in the manual fallback of API mode and for the **Check with
  Google SynthID…** handoff.
- The optional `http://*/*` and `https://*/*` permissions let Lens get an image
  that you select from its host.
- **Grant optional access**, in Settings, asks the browser for site access and
  downloads at the same time.
- As an alternative, Settings can grant one exact origin, such as an image host
  or a backend that you control.
- `web_accessible_resources` lists only `palette.html`, for `http` and `https`
  pages. It is not a permission. See
  [Why `palette.html` is web-accessible](#why-palettehtml-is-web-accessible).

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
- A palette frame on a page can only start an action or cancel the active one.
  The worker accepts these messages only for the active tab where it opened
  that palette.
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
