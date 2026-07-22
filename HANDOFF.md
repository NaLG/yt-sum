# Return YouTube Summary, project status and handoff

Resume-here doc. This plus SUBMISSION.md and docs/DEVELOPMENT.md is everything
needed to continue. No em-dashes anywhere in this project (deliberate style).

## What this is

Firefox extension (MV2, desktop and Android) that adds a Summarize button to
YouTube and summarizes the current video's transcript through the user's own
LLM API key. No backend, no tracking.

- Product name: Return YouTube Summary. Short mark (icon + panel header): TL;DW.
- Publisher/display name: nalg. License: AGPL-3.0-only (repo aligned to the
  AMO listing 2026-07-15; was MIT). Repo: github.com/NaLG/yt-sum.
- Internal ids that must NEVER change (the listing is live): manifest gecko.id
  return-youtube-summary@nalg.dev, CSS .yapsum-* classes, storage keys, local
  dir / npm name yap-sum.

## CURRENT STATE (2026-07-22): 0.5.2 live, 0.5.4 submitted for review

0.5.2 approved and public (verified 2026-07-20). 0.5.4 committed, pushed
(dc9d6f4 + kit fill 30c8e6b), gate-green (9 checks), built as
dist/return_youtube_summary-0.5.4.zip and submitted listed via web-ext sign
with dist/amo-metadata-0.5.4.json. 0.5.3 was consumed by an unlisted
self-distribution sign on the production id and can never be a store
version; sideload/test signs go to the yap-sum@nalg.dev Hub entry (swap the
manifest id temporarily). 0.5.4 contents: extra models + always-visible
panel model chip with per-model summaries/Q&A/cache, model labels,
type-to-filter comboboxes with split-token search, per-row catalog loading,
auto-summarize toggle with a waiting state, streaming finish-reason notices
+ stall watchdog, per-model cache keys, port-free origin patterns, update
self-heal for open tabs, capture-map pruning, near-zero-comment codebase
(rationale in docs/ARCHITECTURE.md, budget lint-enforced), gate grown to 9
checks (style lint, leak bounds, leaked-browser assertion). NEXT SESSION:
verify 0.5.4 appears on the listing, then the remaining Hub queue below
(icon, screenshots, store-install verification).

## PRIOR STATE (2026-07-15): 0.5.1 live, 0.5.2 handed to the Hub

0.5.2 contents: shorts opt-in rail button, movable/resizable panel
(desktop), collapseInPlace setting, run-all release gate, AGPL-3.0
relicense (repo aligned to the listing; was MIT).

## PRIOR STATE (2026-07-11): store identity resolved, v0.5.0 listed

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

## DONE 2026-07-11 (evening): shorts pivot, opt-in rail button (UNRELEASED)

Field discovery on the store build (phone): the button DOES inject on mobile
shorts (the like-button hunt finds the action rail) and summarizing WORKED.
The earlier "shorts expose no transcript surface at all" conclusion was too
broad: it covered the desktop UI surfaces and the reconstruction paths, but
the playback capture grabs the player's own caption fetch on shorts too,
whenever the short has captions (many don't, especially music/meme shorts).
Machine-verified both sites 2026-07-11: captions-intercept, 23 segments, via
test/probe-shorts-desync.mjs (emulator) and the npm-test shorts suite.
Shipped in 0.5.2 (committed 7571c33):

- Default stays NO button on /shorts/ (spotty caption coverage; a button
  that often fails is worse than none). The popup path still summarizes
  shorts; its old hard refusal ("Shorts don't have transcripts") was wrong
  and is gone. Failures show a captions-specific hint.
- New shortsButton setting (options page, instant-apply, default off): a
  round logo button in the shorts action rail directly above the like
  control, 48px desktop / 40px mobile (.yapsum-btn-shorts). It ignores
  buttonStyle (only a circle fits the rail); watch pages keep the user's
  chosen style, default full "Summarize".
- The user's field report of broken tap-to-pause after summarizing a short
  could NOT be reproduced (probe drives both the playing and the paused
  scenario, real extraction, then taps). Their "layout changed when I
  disabled the plugin" observation persisted after re-enable, so it was
  YouTube variant roulette, not us. If tap breakage returns, suspect the
  open panel first: the mobile bottom sheet can cover the reel center.
- Panel drag + resize (desktop www only): dragging the TL;DW title bar
  moves the panel; the left/right/bottom edges and all four corners
  resize it (grips in content.css, wirePanelBar/dragSession in
  content.js). A press that travels under 4px still counts as the
  collapse tap. Geometry lives per tab (survives SPA navigation, never
  persisted); box-sizing on the panel is border-box so resize math and
  getBoundingClientRect agree. The mobile bottom sheet is untouched.
- New collapseInPlace setting (options page, instant-apply, default off):
  the title-bar tap folds the panel up to just its header where it sits,
  instead of docking the bottom-right pill. setCollapsed owns the mode
  switch (sheds the drag/resize inline geometry for the corner dock,
  keeps position/width in place mode); an in-place-folded bar can still
  be dragged. Drag, resize, and both collapse modes are machine-verified
  in test/smoke-full.mjs via synthetic PointerEvents.

Emulator lessons (hard-won, do not relearn):
- `adb shell input tap` is SWALLOWED while a web-ext RDP session is
  attached; a 1px `input swipe x y x+1 y+1 60` delivers as a tap always.
- A fresh Fenix profile blocks autoplay, so m.youtube.com shorts sit paused
  at a poster with the (only) video element parked OFF-viewport until
  playback starts; muted video.play() (what kickMobilePlayback does) starts
  it legally without a user gesture.
- YouTube's reel overlay ACCEPTS untrusted synthetic taps for pause, so
  tap-health is testable without OS input; prefer clicking its own visible
  "Play" aria-label button for the resume direction.

## NEXT work items (user-approved queue)

1. 0.5.1 submitted 2026-07-12 via `web-ext sign --channel=listed`, APPROVED
   and live 2026-07-15. STILL OPEN: install from the store page on BOTH
   phone and desktop (uninstall the old sideload first on the phone, its id
   differs, it will never update) and verify the fresh-install UX: slim
   two-host install prompt, then ONE Allow doorhanger on the first Test
   connection / Save.
2. Product page cosmetics: upload the listing icon (src/icons/icon-128.png,
   manual on Edit Product Page, AMO ignores manifest icons); screenshots
   (docs/mobile-summarize-button.png is STALE, it predates the left-of-like
   placement; capture fresh desktop + phone shots); homepage and support-site
   fields (github repo) can be added there any time.
3. DONE 2026-07-15: README links the live listing (and its feature list
   covers the 0.5.2 panel/shorts additions).
4. Support email, later, optional: support@nalg.dev via Cloudflare Email
   Routing forwarding to a personal inbox. Do not REPLY from the personal
   address (de-pseudonymizes); answer on GitHub issues instead.
5. DONE 2026-07-15 (pending Hub confirmation): 0.5.2 committed (7571c33 +
   08bcc40), full npm test green headless, built, submission notes in
   SUBMISSION.md; user submitted manually via the Hub (web-ext sign creds
   were not at hand this session). Verify the version shows in the Hub next
   session. Also new this release: repo relicensed AGPL-3.0-only (456a06a)
   to match the listing; keep AGPL selected on future version uploads.

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
npm test                                 # release gate: lint + options + placement + shorts
                                         #   + end-to-end + live extraction, one summary table
npm run test:fast                        # inner loop: skips the two slow suites
node test/smoke-placement.mjs --target firefox-android   # mobile placement (real m.youtube.com)
```

`npm test` green is the desktop ship bar; the Android placement run stays a
separate manual step (emulator). test/smoke-shorts.mjs guards the shorts
button policy: no button by default (plus decoy cleanup), round logo rail
button when the shortsButton setting opts in. Screenshot artifacts land in
test/artifacts/ (gitignored). YAPSUM_HEADLESS=1 runs every desktop suite
headless; REQUIRED while the macOS session is locked, headed Firefox cannot
start then and web-ext dies with ECONNREFUSED.

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
