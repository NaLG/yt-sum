# Return YouTube Summary, project status and handoff

Resume-here doc. This plus SUBMISSION.md and docs/DEVELOPMENT.md is everything
needed to continue. No em-dashes anywhere in this project (deliberate style).

## What this is

Firefox extension (MV2, desktop and Android) that adds a Summarize button to
YouTube and summarizes the current video's transcript through the user's own
LLM API key. No backend, no tracking.

- Product name: Return YouTube Summary. Short mark (icon + panel header): TL;DW.
- Publisher/display name: nalg. License: MIT. Repo: github.com/NaLG/yt-sum.
- Internal ids that must NEVER change (the listing is live): manifest gecko.id
  return-youtube-summary@nalg.dev, CSS .yapsum-* classes, storage keys, local
  dir / npm name yap-sum.

## CURRENT STATE (2026-07-11): STORE IDENTITY RESOLVED, v0.5.0 listed

The fresh "Submit a New Add-on" won: the live listing is
return-youtube-summary@nalg.dev at 0.5.0 (repo manifest synced). The OLD
entry (yap-sum@nalg.dev) was renamed "-test" in the Hub and is now the
dedicated SIDELOAD/TESTING channel: sign test builds against it by
temporarily swapping the id back to yap-sum@nalg.dev at build time, so test
signs never burn version numbers on the production entry. Store releases are
0.5.1+ on the production id. The phone's old sideload will not auto-update
(different id); reinstall from the store page once the listing is public.

## DONE 2026-07-12: permission trim (least privilege), v0.5.1

The six provider API hosts moved from `permissions` to `optional_permissions`:
the install prompt is now the two YouTube hosts + the data disclosure, and the
first Save / Test connection for a provider shows ONE Allow doorhanger for
that host alone. Two real bugs found and fixed while validating:
- ensureHostPermission awaited permissions.contains() BEFORE request(), which
  destroys the user-gesture context (documented Firefox behavior: awaiting
  any promise ends the user-input handler). request() is now called FIRST; it
  resolves true silently when already granted, so no probe is needed.
- Test harnesses hardcoded the old gecko.id; smoke-options now reads the id
  from the manifest.
Machine-verified: smoke-options runs the real grant flow (trusted WebDriver
element click on Save, prompts auto-accepted via the
extensions.webextOptionalPermissionPrompts=false test pref, then asserts
"Saved." + permissions.contains for the origin). Synthetic executeScript
clicks do NOT carry user-input status; only trusted WebDriver element clicks
do. smoke-full and smoke-placement pass. Permission reductions ship silently
to existing users. NOTE for the next Hub visit: PRIVACY.md's permissions
paragraph changed (nothing granted at install); re-paste it into the AMO
privacy field.

## NEXT work items (user-approved queue)

1. Ship 0.5.1 to the store: `web-ext sign --channel=listed` (production id is
   in the manifest now; the Hub's Upload New Version also works since the
   entry auto-inherits the LISTED channel).
2. Product page cosmetics: upload the listing icon (src/icons/icon-128.png,
   manual on Edit Product Page, AMO ignores manifest icons); screenshots
   (docs/mobile-summarize-button.png is STALE, it predates the left-of-like
   placement; capture fresh desktop + phone shots); homepage and support-site
   fields (github repo) can be added there any time.
3. README: replace "coming to addons.mozilla.org" with the live listing link.
4. Support email, later, optional: support@nalg.dev via Cloudflare Email
   Routing forwarding to a personal inbox. Do not REPLY from the personal
   address (de-pseudonymizes); answer on GitHub issues instead.

## Version bookkeeping

AMO version numbers are unique per add-on id ACROSS channels; every signed
build burns a number on its entry. Production (return-youtube-summary@nalg.dev):
0.5.0 live, releases continue 0.5.1+. Test entry (yap-sum@nalg.dev, renamed
"-test"): 0.4.x graveyard, keep using it for sideload test signs by swapping
the id at build time so the production version history stays clean.

## AMO lessons (hard-won 2026-07-11, do not relearn)

- The Developer Hub hides ALL channel UI until an add-on has a listed version
  (template-gated on has_listed_versions). "Upload a New Version" is
  submit_version_auto and silently inherits the unlisted channel.
- The reliable listed-submission path for an unlisted-born add-on is
  `web-ext sign --channel=listed`; its "wait up to 24h for an email" ending
  IS success (listed versions return no xpi, AMO hosts them).
- Deleted AMO add-on ids are permanently reserved. Never delete-and-resubmit.
- Author email is never displayed publicly; the AMO profile DISPLAY NAME is
  (set to nalg). Do not tick "list email". EULA off (adds an install
  interstitial). Privacy policy field is plain text: PRIVACY.md is kept in
  paste-ready single-line form.
- Validation warnings do not block auto-approval. The three current ones are
  accepted: desktop min 115 predates the consent-UI manifest key (old Firefox
  ignores it; raising to 140 would cut ESR), and two Android
  permissions.request warnings where the linter checks the desktop min
  instead of gecko_android (142).
- When answering Developer Hub UI questions, check the addons-server source
  (urls.py, devhub templates), not memory: the UI is state-dependent.

## Getting a build

```
npm run build      # -> dist/return_youtube_summary-<ver>.zip (UNSIGNED; same package for desktop + Android)
# Private sideload copy for a phone (burns the version number):
web-ext sign --api-key=<issuer> --api-secret=<secret> --channel=unlisted --source-dir src --artifacts-dir dist
```

- Desktop testing: about:debugging, Load Temporary Add-on, pick the zip.
- Android sideload: signed xpi via the debug-menu "Install extension from
  file", see MOBILE-TESTING.md. Once the listing is live, install from AMO
  instead.
- dist/ is gitignored; builds live only on the build machine.

## Test and verify

Canonical command list lives in docs/DEVELOPMENT.md. The non-negotiables:

```
node test/smoke-full.mjs [VIDEO_ID]      # authoritative end-to-end (mock LLM)
node test/smoke-placement.mjs            # button placement + all 4 styles, geometric asserts
node test/smoke-placement.mjs --target firefox-android   # same on the emulator (real m.youtube.com)
```

Tests run the real source inside a normal Firefox via web-ext (never
WebDriver; YouTube detects and blocks marionette). Mobile-visible changes DO
NOT SHIP without the Android placement run or an emulator screenshot
(docs/DEVELOPMENT.md, "Verifying mobile UI"); check the address bar in
verification screenshots, a silent bounce to a desktop-param URL renders a
different variant and gives false proof.

## Open backlog (not scheduled)

- Tier 2 mobile transcript fallback: hidden desktop-UA iframe of the watch
  page, capture via the existing intercept. Only needed if field failures
  resurface; the play tip resolved the known case.
- "Regenerate summary" affordance (cache currently restores within its 30 min
  TTL rather than regenerating).
- The dormant capture diagnostics (pot/fmt/status/fromCache) stay in the
  code; they surface only in the failure debug bundle.

## Repo push gotcha (important)

Origin is git@github.com:NaLG/yt-sum.git. The repo's `git config
core.sshCommand` forces the yt-sum deploy key (~/.ssh/deploy_key_yt-sum) and
bypasses the ssh-agent, which otherwise shadows it with another repo's key.
With that config, plain `git push` works. Commits use the GitHub noreply
identity (nalg <295770+NaLG@users.noreply.github.com>); never commit with a
personal email, history was rewritten once already to scrub it.

## Extraction: the hard-won lessons

See docs/EXTRACTION.md (canonical) and the code comments. In short: only
capturing YouTube's own player traffic works (webRequest.filterResponseData,
keyed by video id); reconstruction gets 400 and direct timedtext gets an
empty 200, both attestation-gated. Mobile needs real playback for the fetch
to fire; the 2.5s play tip covers the autoplay-blocked case and a user tap is
picked up within ~300ms by the capture polling.
