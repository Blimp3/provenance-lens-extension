# Changelog

## [2.1.0] - not yet released

Moves every setting that can change inside the palette into it, except site
access. Every version field is 2.1.0, a minor version for the two new
permissions, with no tag or release yet.

### Added

- **Settings** in the Lens palette, in the groups DigiBot, Verification,
  History and privacy, Keys and About. Every row is also a search result on
  the first view, every change saves at once, and **⌘K** offers **Reset to
  default** on each setting row. The last row, **Advanced settings ↗**
  (Backend URL, client token, site access), opens the Settings page in a
  tab: the API connection settings and site access stay there, and the
  palette never shows or uses the client token. The Settings page stays the
  browser's Options page and does not change.
- **Settings › DigiBot** pairs DigiBot inside the palette: the consent text,
  **Provider processing details ↗** and **Start pairing and copy /link**,
  which creates the pairing, shows the `/link` command and its confirmation
  code, and copies the command. Lens then checks for the approval every 3 s
  for the first 30 s and every 30 s after that, for at most 5 minutes, within
  DigiBot's limit of 20 checks per 10 minutes, and then shows the timeout
  message and **Start again**. While a pairing waits, the first view shows
  **Complete DigiBot pairing**. When connected, **Disconnect DigiBot…** asks
  first.
- The other settings rows: **Verification mode**, with the two mode
  disclosures as its hint, and **Screenshot copy fallback**; **Keep
  history**, **Local cache**, **Save page title**, **Debug details**, **Clear
  history…** and **Clear verification cache…**; **Palette shortcut ↗**,
  **Command hotkeys** and **Aliases** with **Reset aliases…**; the version,
  **What a result means** and the line "Lens never scans pages." Switching
  the mode only saves it: the first verification in a mode still shows its
  disclosure. Each clear, **Disconnect DigiBot…** and **Reset aliases…** ask
  first, with **Cancel** as the first choice.
- **Finish setup** rows on the first view for **Connect DigiBot** (or
  **Complete DigiBot pairing**) and **Grant optional access**, next to
  **Choose a palette shortcut**, each shown until it is done.

### Changed

- **Settings**, the toolbar's right-click **Settings…**, the row **Connect
  DigiBot** and the toast buttons **Connect DigiBot** and **Switch to API**
  open the palette at Settings, Settings › DigiBot or Settings › Verification
  mode, on the current page or in the popup on a browser page, instead of the
  Settings page in a tab. Site access stays on the Settings page: the rows
  **Needs download access** and **Grant optional access**, the toast button
  **Grant access** and **Also check with Google ↗** without download access
  open its **Extension access** card in a tab, as before. History and the
  browser's shortcuts page still open in a tab.
- One copy path for the `/link` command: in the popup or a tab the palette
  uses the Clipboard API; over a page it asks Lens's worker, which copies
  through one offscreen document, so a page whose Permissions Policy blocks
  its frames from the clipboard does not stop the copy. If that fails, the
  palette selects the command and asks you to press ⌘C (Ctrl+C outside a
  Mac).

### Fixed

- A click on a palette row right after the page zoomed is refused until the
  panel has been visible at its new size for 500 ms, also before the frame's
  resize event arrives. It could run the row the zoom moved under the pointer.

### Security and privacy

- New permissions `clipboardWrite` (install warning "Modify data you copy and
  paste.") and `offscreen`, for the worker's copy. The worker copies only for
  a palette frame it mounted on that tab, and only the pending pairing's
  `/link` command; a palette frame inside a page never writes to the
  clipboard itself, and the offscreen document copies only for the worker.
- Every settings change, Run, form submit and confirmation goes through the
  palette's input gate (trusted input only, the 250 ms and 500 ms visibility
  rule, the host check), so a page cannot change a setting, start or stop
  pairing or clear data with synthetic input or a covered frame. Opening the
  palette or its Settings view starts no check and sends no request; a
  pairing request starts only from **Start pairing and copy /link** or
  **Start again**, one at a time, and **Complete DigiBot pairing** resumes a
  pending one. Over a page, a key pressed before the palette shows is
  dropped when it opens at a Settings view, which a page's click on a toast
  button can open.

### Tests

- Unit tests for the palette Settings rows, saves, validation messages,
  confirmations, the pairing checks, copy routing and the single offscreen
  document, and that no Access row is in the palette or its search and each
  Access link opens the Settings page's **Extension access** card; worker
  tests for the palette view each button opens, for **Also check with
  Google ↗** without download access and for refused copy requests; browser
  tests for the copy on a page whose Permissions Policy blocks the frame's
  clipboard, and for a synthetic click or key on a settings row.

## [2.0.0] - 2026-10-28

The extension and shared code are the private edition's 2.0.0 (base
`eeba7e4`), with only the public-edition differences recorded in
[SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md). This release adds the pick banner
and result toasts, and the Lens palette, which replaces the toolbar popup. The
picker runtime is 0.9.0.

### Added

- The Lens palette: **Alt+Shift+Space** (⌥⇧Space on a Mac), a toolbar click or
  the right-click item **Open Lens palette** opens a search field and command
  list over the page, in a frame inside a closed shadow root. It has the views
  Root, Download, Verify, Clip and Recent, and an action panel on **⌘K** with
  Run, Set alias…, Clear alias and Set hotkey…. Search ranks aliases first,
  **Last used** keeps the last three commands, ⌥1 to ⌥9 run rows by position,
  Esc steps back one level at a time and Tab never leaves the palette. Opening
  it reads only local storage: it starts no check and sends no request. Over a
  page, it runs a row only once the browser has reported it visible for 250 ms
  (a key) or 500 ms (a click), with no hidden report in between. A key pressed
  in its first second waits for that unless the palette is reported hidden
  first; other refused input is dropped, and the palette shows "The page is
  covering Lens. Press Esc and open it again." A page zoom restarts that
  wait. The palette closes when the page restyles or hides its host or
  cancels its show. The key that closes the palette sends no keyup to the
  page, though a page's own capture listener on window can still see that
  keyup. Over a fullscreen element, Lens asks for Keyboard Lock on Esc while
  the palette is open, so that Esc steps back in the palette and a press and
  hold leaves fullscreen. In Brave, one Esc still leaves fullscreen (checked on
  a YouTube player). Known limits: while the palette is open its Esc lock
  replaces a wider keyboard lock the page held, and closing the palette ends
  that lock; Keyboard Lock exists only on secure (https) pages, so on an http
  page Esc still leaves fullscreen. When a video element itself is
  fullscreen, the palette shows and its keys work, but clicks and Esc do not:
  a click on a row does nothing and Esc does not close the palette. The
  palette also closes when the page hides, moves or restyles its host behind
  a stopped event or cleared timers: the host checks itself whenever the page
  moves or restyles it, and the palette asks the host to confirm it every
  100 ms and before each run.
- Ten browser commands: **Open or close the Lens palette** (suggested
  Alt+Shift+Space), **Pick an image for OpenAI provenance review** (Alt+Shift+V,
  unchanged), and, with no key until you set one, send this page's video, voice
  note or audio file, pick an image or a video for Telegram, pick a post for its
  voice note or audio file, cancel the running verification or pick, and open
  the palette at Clip. When the browser leaves the palette key unassigned,
  **Choose a palette shortcut** opens its shortcuts page.
- **Pick to download…** (alias p) in the Download view: one pick where the
  topmost layer under the click decides. An image goes to DigiBot as the image
  download, and a video as its link with the checks and limits of **Send
  video**. On X a post with two or more videos, a quoted post's counted, sends
  the clicked one as `https://x.com/<user>/status/<id>/video/<n>`, and any
  other post its plain address. Known limit: a GIF in a post with two or more
  videos cannot be sent alone, and a post that shows a photo without its
  `/photo/<k>` link goes as its plain address, which DigiBot refuses as a
  playlist when the post holds two or more videos. A YouTube or Vimeo embed
  sends its video's own page (an unlisted Vimeo video with its hash, as
  `https://vimeo.com/<id>/<hash>`); a YouTube channel's live stream embed
  and a video with no post or video link send the page, as **Send video**
  does. It replaces the two picks
  **Pick a post → video…** and **Pick an image → Telegram…**: a shortcut set
  for either old command is gone, so set it again for **Pick an image or a
  video and send it to Telegram**. A Last used entry of either old pick shows
  the new row, and an alias set for one is dropped.
- Right-click items: **Send this image to Telegram**, **Send link to Telegram
  as video**, **…as voice note** and **…as audio file**, **Send this video to
  Telegram**, **Lens palette for this video…** and **Open Lens palette**, and
  on the toolbar icon **Settings…**, **Recent actions…** and **Result
  history**. One shared menu rebuild serves install, startup and worker start.
- **Recent** lists your last actions, not only saved Verify results: one entry
  for each action you start from the palette, a key, a right-click item or a
  toast button, with its command title, kind (what Telegram gets: image,
  video, audio file, voice note or clip; Verify; a page link only for a
  download pick before its click), page title, the page's origin and path,
  the full link a link send sent, start time, final state (sent, done,
  failed, refused or cancelled, with its short message, any address in it cut
  at its query or fragment and without a user name and password) and the
  DigiBot operation id when there is one.
  It shows the newest eight with a kind icon and a state label; a download
  pick's entry becomes **Sent video** or **Sent image** at the click, and a
  cancel shows **Cancelled** in the neutral tone.
  ↵ opens a Verify entry's details, a link send's address or a DigiBot
  entry's Result history, and **Result history** stays under More. An entry
  the browser stopped Lens before finishing ends as failed with "Lens stopped
  before this action ended." at Lens's next start, a resumed DigiBot
  operation ends its own entry, a disclosure tab closed unacknowledged
  cancels its action, and an entry still running after ten minutes shows as
  stopped. The list stays in local storage, keeps as many entries as History
  retention (none with history off, applied as soon as the setting changes),
  keeps the page title only when history saves titles, and **Clear history**
  or the History page's **Clear all** clears it.
- Audio sends: **Send voice note** posts an OGG/Opus voice note and **Send
  audio file** an M4A with its title and music player, for this page or, with
  **Pick a post → voice note…** and **Pick a post → audio file…**, for a post
  you click. The page link's output is now `voice`, `m4a` or `mp3`, and the
  pinned DigiBot contract fixture records a voice and an M4A request. These
  rows need DigiBot 5.5.0 or later, whose link route accepts the voice-note
  and M4A outputs; DigiBot 5.0.0 accepts only MP3 and refuses them.
- **Verify audio of this page…** and **Clip › Verify this clip's audio** check 1
  to 60 seconds of the page's video through DigiBot in the background. The
  page shows the progress and the result as a toast.
- On a browser page, or a page that refuses the palette, the palette opens as a
  popup under the toolbar icon, and in a tab if the browser refuses the popup.

- Picker: a banner at the top of the page names the action (**Verify**,
  **Send image**, **Send video** or **Google SynthID**), what to click and Esc
  to cancel; for **Pick to download…** it reads "Click an image or a video". A click on nothing pickable shows a 2-second warning in the
  banner, and the hover label names the verb (Click to verify, send or save).
- Toasts: a progress toast with a spinner while work runs, with **Cancel** for
  an image check (**Stop waiting** for a connected one), then a result toast in
  a success, detected, no-signal, pending or error tone with up to two
  buttons: **Details**, **History**, **Retry**, **Connect DigiBot**,
  **Grant access**, **Switch to API** or **Also check with Google ↗**. A
  success toast hides after 6 seconds, paused while hovered or focused. Toasts
  follow the light and dark theme, forced colors and reduced motion. A toast
  button ignores a click while the toast host's computed opacity is not 1 or
  its visibility is not visible. A page can still hide a toast button under its
  own content; toast buttons only run follow-up actions that the user already
  started, and the page cannot read their results.
- **Check with Google SynthID…** in the Verify view, with the note "Google has no
  SynthID API yet, so Lens opens Google's SynthID Detector with your file. Lens
  will check it directly once Google releases an API.", and **Also check with
  Google ↗** on an image result whose exact file Lens retrieved (not on a
  screenshot copy). After one click on the image, Lens saves its
  exact bytes and opens Google's SynthID Detector (`https://synthid.com/`) in a
  new tab, where you upload the file yourself. Lens uploads nothing to Google,
  never scripts that site and keeps no history record or cache entry for it.
  The first handoff asks once for an acknowledgement that names Google, the
  copy in the download folder and Google's 24-hour file signature. Download
  access stays optional.

### Changed

- The toolbar icon opens the palette instead of a popup. For now, the palette's
  **Settings**, **Connect DigiBot** and **Needs download access** rows and the
  toast buttons **Connect DigiBot**, **Grant access** and **Switch to API** open
  the Settings page in a tab. The Website mode message for missing download
  access points to Settings.
- The image right-click item is now **Verify this image** (it was **Check
  OpenAI provenance**).
- **Send video**, **Send voice note** and **Send audio file** on an X or YouTube
  listing page (X home, search, explore or a profile; YouTube home, search
  results, a feed, a channel or a playlist) start the post picker instead of
  sending the page address. Every other page is sent as before.
- Lens no longer offers MP3: the voice note and audio file replace it.
- **Cancel** in the palette and the cancel command also stop a picker that is
  waiting for a click.
- A Clip range is typed in one field, for example `1:30-2:10`, `90-130` or
  `1:02:03-1:05:00`.
- Version 2.0.0 in the root package, every workspace package, the extension
  manifest and `package-lock.json`.
- Each connected DigiBot request stops after 30 s. A status request also stops
  when the 60 s status wait ends. Before, one request that got no answer did
  not stop.
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
- The banner, the picker overlay and the toast mount inside the modal dialog
  that holds the focus, else a fullscreen element (unless that element is the
  media itself), else the modal dialog hit at the top-left corner, else the
  last modal dialog, also inside an open shadow root, so they stay visible and
  clickable there. They mount again when the page closes that dialog, also
  when it then removes the dialog, and when it enters or leaves fullscreen.
  The toast's buttons work while the picker is armed. Page handlers in the
  bubble phase do not see the toast's mouse-button, pointer-button and key
  events. Capture-phase listeners on window or document can still see a click
  on the toast host, and movement, touch, wheel and focus events still bubble.
- A page-link send from the palette shows its progress and result as a toast on
  the page. A failed send offers **Retry** once, and a missing DigiBot
  connection offers **Connect DigiBot**. An image check that is still running
  on that page still shows its result there.
- Copy: a link send reports "Queued in DigiBot. The result arrives in your
  Telegram chat." A delivered image download shows **Image sent to Telegram**,
  and Website mode and the SynthID handoff show **Exact image saved**.

### Removed

- The toolbar popup (`popup.html`) and the popup reopen after a picker-started
  API check. The in-page toast, the badge and the palette's Recent view show
  the result.

### Fixed

- **Stop waiting** during a token refresh stops at once, with no error toast.
  The refresh continues with its own 30 s deadline, and Lens always saves the
  new tokens (#12).
- A stop during image retrieval shows "Stopped before anything was sent." for
  Verify and for Download (#12).
- A result toast for a picked image now shows when it carries a button. Its
  saved binding kept the picker session's other fields, failed validation and
  dropped the toast.
- Explicitly saved loopback backend URLs (`127.0.0.1`, `localhost` or `[::1]`)
  stay unchanged. Only a legacy settings record with exactly
  `http://127.0.0.1:8787` and no client token changes to the default backend
  URL.
- An audio check that starts while Lens's worker wakes up stays **Started** in
  Recent. The worker's start-up sweep could mark it "Lens stopped before this
  action ended." while it still ran.
- **Pick to download…** on an embedded YouTube or Vimeo player sends the
  video's page. The click went to the player, which paused, because a
  cross-origin frame gets the clicks over it; while a pick is armed, a
  transparent shield in the picker overlay covers each such player that shows.

### Security and privacy

- `web_accessible_resources` lists only `palette.html`, for `http` and `https`
  pages. A palette frame renders only with the single-use token the worker
  stores when it opens the palette, so a page that embeds it gets a blank frame
  that sends nothing. The worker accepts `start-action` and `cancel-active`
  from a palette frame only for the active tab it mounted the palette into.
  Each host's port carries its own token, and no palette closes another
  palette's port.
- Lens reads DigiBot JSON responses with a size limit: 4 MiB for History and
  1 MiB for all other responses.
- Video URLs for audio-segment checks do not include the URL fragment. This
  applies to the audio page prefill, the outbox and the segment request. Lens
  also removes the fragment from old outbox entries before it sends them again.
  The audio page says that the query string goes with the video URL.
- Dependency updates for security advisories: music-metadata 11.16.1
  (CVE-2026-107391, CVE-2026-107389), sharp 0.35.5 (CVE-2026-96889) and
  source-map-js 1.2.2 (CVE-2026-93749).
- Dependency updates for the October 2026 npm advisories: zod 4.6.7
  (GHSA-mrhx-c7xc-m3w5), undici 8.12.3 and vite 8.3.5 (through vitest 4.1.12).
- Node.js 24.22.1 in `.nvmrc`, the fixed release of the October 2026 Node.js
  security release.

### Documentation

- README: the Lens palette (opening, keys, the ten commands, the right-click
  list, restricted pages, why `palette.html` is web-accessible and the Google
  SynthID handoff). The note "There is no right-click menu for videos" is gone.
- README: the Verify view includes **Check with Google SynthID…**, with what
  it saves and sends.

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
