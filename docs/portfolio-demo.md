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

The five browser flows cover the popup/settings surface, first and repeated
picker activation, exact image and audio bytes, C2PA trust wording, and
synthetic connected Check/Download operations. Check and Download remain
separate: Download delivers the original without invoking verification.

For a manual Website-mode walkthrough, serve the fixtures locally:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 \
  --directory apps/extension/tests/fixtures
```

Load `apps/extension/dist` as an unpacked extension, open
`http://127.0.0.1:4173/fixture.html`, keep **Website review** selected, and use
the popup picker. Lens downloads the exact image and opens OpenAI Verify for
manual upload. It does not automate the website or create an API result.

These checks establish the local source/package behavior. They do not establish
production service availability, installed-browser user acceptance, or security
of historical private releases and repository history. The project source in
this candidate is licensed under MIT; the bundled notices and file-specific
terms remain separate.
