# Return YouTube Summary, project status and handoff

Resume-here doc. This plus SUBMISSION.md and docs/DEVELOPMENT.md is everything
needed to continue. No em-dashes anywhere in this project (deliberate style).

## What this is

Firefox extension (MV2, desktop and Android) that adds a Summarize button to
YouTube and summarizes the current video's transcript through the user's own
LLM API key. No backend, no tracking.

- Product name: Return YouTube Summary. Short mark (icon + panel header): TL;DW.
- Publisher/display name: nalg. License: MIT. Repo: github.com/NaLG/yt-sum.
- Internal ids that must not change once users exist: manifest gecko.id, CSS
  .yapsum-* classes, storage keys, local dir / npm name yap-sum. CAVEAT: the
  gecko.id itself is UNVERIFIED right now, see Current state.

## CURRENT STATE (2026-07-11, late): store submission is IN, identity unverified

Two listing submissions happened while fighting AMO's channel plumbing, and it
is not yet confirmed which one is the live listing:

- (a) 0.4.16 under gecko.id yap-sum@nalg.dev, submitted with
  `web-ext sign --channel=listed` (the wait-for-email ending, which is what a
  successful listed submission looks like).
- (b) Probably ALSO a fresh "Submit a New Add-on" with
  dist/return_youtube_summary-0.5.0.zip under NEW id
  return-youtube-summary@nalg.dev (the user completed the whole new-submission
  flow: MIT license picked, privacy policy pasted, reviewer notes with repo
  link, permissions summary reviewed; reported "submission is in, page is up
  differently than before").

FIRST TASK NEXT SESSION: open the Developer Hub, determine which entry has the
live/approved listed version, then sync the repo to match (manifest gecko.id +
version, SUBMISSION.md id line, this file). If (b) won: the repo id becomes
return-youtube-summary@nalg.dev at version 0.5.0, and the phone's sideloaded
copy will NOT update to the store version (different id, one-time reinstall
from the listing). NEVER delete the losing AMO entry expecting to reuse its
id: deleted AMO ids are permanently reserved.

## NEXT work items (user-approved queue)

1. Verify which submission is live and sync repo identity (above).
2. Permission trim (least privilege): move the six provider API hosts from
   `permissions` to `optional_permissions` in the manifest. The options page
   already has the machinery (ensureHostPermission() requests origins at
   Save / Test connection, inside a user gesture); the Android floor of 142
   supports permissions.request. Result: the install prompt shrinks to the
   two YouTube hosts + the data disclosure, and users grant only the one
   provider they actually use. Validate the grant prompt on desktop and
   Android before shipping. Permission REDUCTIONS update silently for
   existing users.
3. Product page cosmetics: upload the listing icon (src/icons/icon-128.png,
   manual on Edit Product Page, AMO ignores manifest icons); screenshots
   (docs/mobile-summarize-button.png is STALE, it predates the left-of-like
   placement; capture fresh desktop + phone shots); homepage and support-site
   fields (github repo) can be added there any time.
4. README: replace "coming to addons.mozilla.org" with the live listing link.
5. Support email, later, optional: support@nalg.dev via Cloudflare Email
   Routing forwarding to a personal inbox. Do not REPLY from the personal
   address (de-pseudonymizes); answer on GitHub issues instead.

## Version bookkeeping

AMO version numbers are unique per add-on id ACROSS channels; every
sideload-signed build burns a number. Burned on yap-sum@nalg.dev:
0.4.1-0.4.3, 0.4.6, 0.4.10, 0.4.13, 0.4.14 (sideloads), 0.4.15 (the channel
accident), 0.4.16 (listed submission). The new-id entry starts at 0.5.0.

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
