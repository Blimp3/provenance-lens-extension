# Portfolio demo

This local demo uses deterministic fixtures and mocked browser routes. It does
not require an API key, backend, Telegram account, DigiBot token, Cloudflare
binding, production media, or personalized package.

```sh
npm ci
npm run check
npm run test:e2e
npm run package:public
```

The sixteen browser flows cover the settings page, the Lens palette (its token
gate, keys, mount above modal dialogs and fullscreen elements, and the
covered-panel gate, which refuses input while a page covers the palette and
closes it when the page restyles its host), the SynthID pick above a modal
dialog, first and repeated picker activation, exact image and audio bytes,
C2PA trust wording, and synthetic connected Check, Download and page-link
operations. Check and Download remain separate: Download delivers the original
image without invoking verification, the same pick on a post's video sends
that video's address, and the page-link send carries only the page address.

For a manual Website-mode walkthrough, serve the fixtures locally:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 \
  --directory apps/extension/tests/fixtures
```

Load `apps/extension/dist` as an unpacked extension, open
`http://127.0.0.1:4173/fixture.html`, keep **Website review** selected, open the
Lens palette with the toolbar button or Alt+Shift+Space, and choose **Verify**,
then **Pick an image to verify…**. Lens downloads the exact image and opens
OpenAI Verify for manual upload. It does not automate the website or create an
API result.

These checks establish the local source/package behavior. They do not establish
production service availability, installed-browser user acceptance, or security
of historical private releases and repository history. The project source in
this edition is licensed under MIT; the bundled notices and file-specific
terms remain separate.
