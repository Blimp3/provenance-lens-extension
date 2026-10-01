# Release checklist

Use this for every public source release of this edition. Work from a clean
checkout with Node.js 24.20.0 (`.nvmrc`) and npm 11.6.2.

1. **Copy only public source.** Bring over changes from the new private
   commit only for the included paths in
   [SOURCE_PROVENANCE.md](../SOURCE_PROVENANCE.md).
   Never copy server or Worker code, Cloudflare bindings or migrations,
   provisioning or deployment scripts, `.env*`, `.dev.vars*`,
   `.bundled-client.json`, tokens, owner data, internal paths or operational
   evidence.
2. **Bump one version everywhere.** Use the same version in `package.json`,
   every workspace `package.json`, the `@provenance-lens/shared` dependency
   pin in `apps/extension/package.json`, `apps/extension/manifest.json`,
   `package-lock.json` and the ZIP name in `README.md`, and add a dated
   [CHANGELOG](../CHANGELOG.md) entry. `npm run check` fails if any of these
   versions disagree; the CHANGELOG entry stays manual.
3. **Run every check.**

   ```sh
   npm ci
   npx playwright install chromium
   npm run check
   npm run test:e2e
   npm run package:public
   ```

   `package:public` audits the manifest permissions and scans the built
   extension for provider keys and unapproved `workers.dev` hosts.

4. **Scan the tracked source.** `npm run scan:source`, which `npm run check`
   also runs, rejects local user-directory paths, provider-key-shaped strings
   and `workers.dev` hosts other than the DigiBot gateway allowed in
   `scripts/scan-extension.mjs`, in every tracked file except the scanner's
   own test. Fix every hit rather than adding an exclusion.
5. **Update the records.** In `SOURCE_PROVENANCE.md`, record the new private
   base commit, the review date and any new public-edition difference. Update
   `THIRD_PARTY_NOTICES.txt` when the bundled packages change.
6. **Regenerate the manifest** after the last file change (stage new files
   first, since it lists tracked files), then check it:

   ```sh
   git ls-files | grep -vx SOURCE_MANIFEST.sha256 | sed 's|^|./|' \
     | LC_ALL=C sort | tr '\n' '\0' | xargs -0 shasum -a 256 \
     > SOURCE_MANIFEST.sha256
   shasum -a 256 -c --quiet SOURCE_MANIFEST.sha256
   ```

7. **Wait for green CI** on the release commit in `main`.
8. **Publish (owner only).** Tag `vX.Y.Z` on that commit, create the GitHub
   release, attach `artifacts/provenance-lens-extension-vX.Y.Z-public.zip` and
   paste its `shasum -a 256` output into the release notes.
