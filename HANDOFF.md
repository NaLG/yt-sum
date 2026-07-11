# Return YouTube Summary, project status and handoff

Resume-here doc. If the session dropped, this plus `SUBMISSION.md` is everything
needed to finish. No em-dashes anywhere in this project (deliberate style choice).

## What this is

Firefox extension (MV2, desktop and Android) that adds a **Summarize** button to
YouTube and summarizes the current video's transcript through the user's **own**
LLM API key. No backend, no tracking.

- **Product name:** Return YouTube Summary. **Short mark (icon + panel header):** TL;DW.
- **Publisher/display name:** nalg (their GitHub name). **License:** MIT.
- **Repo:** github.com/NaLG/yt-sum (branch: master).
- **Internal ids that must NEVER change:** manifest `gecko.id` = `yap-sum@nalg.dev`,
  CSS `.yapsum-*` classes, storage keys, and the local dir / npm name `yap-sum`.
  Only the user-facing display strings are "Return YouTube Summary" / "TL;DW".

## RESOLVED: mobile empty timedtext (2026-07-11, v0.4.5-0.4.6)

Field failure on the user's phone (Android 16, Fx 152, m.youtube.com, video
i2YQUXykYM0): video playing, ~50s of capture polling, then ONE player-initiated
timedtext at ~57s whose body was 0 bytes. Desktop extracts the same video fine
(smoke-full PASS, method intercept), and the video has an asr captionTracks
entry on both sites, so the video is healthy; this is mweb-specific.

Hypotheses, in order: (a) mweb's lone timedtext was a pot-less probe and no
pot-carrying retry followed because captions were never displayed; (b) YouTube
now empty-200s even the mweb player (arms race move: then Tier 2 iframe is the
answer); (c) the body exists but is invisible to filterResponseData (service
worker / cache path; desktop test profiles are SW-free, the user's phone
isn't). v0.4.5 adds discriminating diagnostics: timedtext request logs
pot/fmt/kind/lang, and an onCompleted listener logs status + fromCache.

USER DECISION (2026-07-11): no field diagnostics; ship with the play tip. The
user's lived experience is "if the video is (really) playing, the transcript
pulls immediately". The diagnostics stay in the code but are dormant: they
only surface inside the failure-path debug bundle. The Copy-debug button has
only ever existed on the failure message; success shows nothing debug-like.

## RESOLVED: how to actually publish LISTED for an unlisted-born add-on

The Developer Hub HIDES all channel UI until an add-on has at least one
listed version (template-gated: has_listed_versions). "Upload a New Version"
is submit_version_auto and silently inherits the unlisted channel. The
working path, no Hub UI involved:

    web-ext sign --api-key=<issuer> --api-secret=<secret> --channel=listed \
      --source-dir src --artifacts-dir dist

Listed submissions return no xpi (AMO hosts/signs them); web-ext ends with
"wait for an email, up to 24h", which IS success. Verify in Manage Status &
Versions: versions grow "AMO" vs "Self" channel tags once both channels
exist, and the Listing visibility control appears. NEVER delete the add-on
entry expecting to reuse its id: AMO permanently reserves deleted ids.
Listing icon is a manual upload on Edit Product Page (AMO ignores manifest
icons); screenshots same place.

## Current state: v0.4.16, LISTING SUBMISSION IN FLIGHT (via --channel=listed)

CHANNEL TRAP (2026-07-11, cost one version): the Developer Hub "Upload a New
Version" flow let 0.4.15 land in the UNLISTED channel (the add-on's original
channel from web-ext sign), producing a signed-but-private version and a
"tentatively approved / now available at" email that LOOKS like a listing.
Tell: the version page banner says "This is not a public listing" and the new
version sits in the same list as the sideload builds. The listed upload MUST
explicitly select channel "On this site". Product-page metadata (name,
summary, description, privacy, authors) lives on the ADD-ON and survives;
it goes public when a listed version is approved. 0.4.15 is burned; 0.4.16 is
the listing artifact.

0.4.16 = 0.4.15 + gecko_android strict_min_version 120 -> 142 (Android
support floor for data_collection_permissions; clears Android validation
warnings and keeps the listing's Android install button). Remaining lint
warnings (3) are accepted: desktop min 115 predates the consent-UI key
(gracefully ignored by old Firefox; raising to 140 would cut ESR), and two
Android permissions.request warnings where the linter checks the desktop min
instead of gecko_android (runtime already guards that API).

## Previous: v0.4.14, placement re-specced LEFT OF LIKE and machine-verified

USER DECISION (2026-07-11): the button goes immediately LEFT of the like
(thumbs-up) control, desktop AND mobile (supersedes right-of-Subscribe). New
in 0.4.14:
- Anchor = the like component, tried in priority order (scoped desktop
  segmented tags, scoped mweb tag, bare like-button-view-model /
  ytm-like-button-renderer, aria-label ^like fallback), each candidate must be
  VISIBLE and OUTSIDE the player (the player chrome has its own hidden like
  button that precedes the metadata in document order; comma-joined
  querySelector returns document order, so selectors are tried sequentially).
- Fourth button style "sum" (small Sum pill): text | sum | tldw | icon.
- test/smoke-placement.mjs: runs the REAL extension (web-ext, reporter content
  script, localhost relay; --target firefox-android uses adb reverse and
  fires the watch URL by intent AFTER web-ext prints Installed, on stdout OR
  stderr). Asserts geometrically for every style: same row as like, strictly
  left of it, content width. Desktop 13/13 and emulator mweb (merged-row
  variant, the user's own) 13/13. Field bonus: mobile's merged row overflows
  with full "Summarize" and the auto-collapse to "Sum" fired as designed.
This is the placement-verification loop that was missing during the
0.4.8-0.4.13 saga; run it for ANY change near the button.

## Previous: v0.4.13 subscribe-anchor round (superseded by left-of-like)

v0.4.12 still failed on the user's phone. Second root cause: mweb A/B
variants. The user's signed-in layout is the MERGED-ROW variant: avatar +
Subscribe(d) + like/dislike/share/save all in ONE row, and it contains NO
ytm-slim-owner-renderer at all, so the container-tag targeting missed and
fell back to the strip again. (The 0.4.12 emulator "proof" had silently
bounced through a desktop-param URL and verified a DIFFERENT variant, the
two-row Join/Subscribe one. Trap for the future: check the address bar says
m.youtube.com in verification screenshots.)

Fix (0.4.13): stop targeting containers on mobile. Anchor the SUBSCRIBE
CONTROL itself (ytm-subscribe-button-renderer, yt-subscribe-button-view-model,
or first of the first-40 buttons whose text is Subscribe/Subscribed) and
insertAdjacentElement("afterend"). Right-of-Subscribe by construction on any
variant. Verified by emulator screenshot ON the merged-row variant (true
m.youtube.com URL): avatar, Subscribe, Summarize, then the action icons, one
row. The Sum overflow-collapse now measures the actual parent row. The debug
bundle's pageFacts now report summarizeBtnParent/PrevSibling + which subscribe
anchors exist, so any future misplacement report carries the DOM truth.

## Previous: v0.4.12 emulator round (superseded, kept for the method)

v0.4.11 (owner-row placement) still failed on the user's phone. ROOT CAUSE,
found by actually screenshotting the emulator: mweb hydrates the actions strip
BEFORE the owner row, and ensureButton's "already connected, do nothing" guard
froze the button in whichever host existed first, i.e. the strip, which
renders ABOVE the channel row. Desktop never hit it because its owner row
exists by injection time. Fix (0.4.12): the button MIGRATES, ensureButton
re-places it whenever it is not parented by the CURRENT preferred host, and
logs the chosen host to the console. Verified by screenshot on the emulator
(true m.youtube.com, mobile UA): TED row reads avatar, Join, Subscribe,
Summarize, on one row; actions strip clean. Desktop smokes still pass.

LESSON (do not repeat): mobile UI changes were shipped three times on
DOM-selector reasoning without ever LOOKING at a rendered Android page; only
extraction had Android coverage. The screenshot recipe now lives in
docs/DEVELOPMENT.md ("Verifying mobile UI"); use it before shipping any
mobile-visible change. The v0.4.11 chip scale (.yapsum-btn-mrow) and the
Summarize->Sum overflow collapse are unchanged and now actually reachable.

New in 0.4.10: last user-visible "yap-sum" strings rebranded (the no-API-key
error now names Return YouTube Summary and points at the settings links; the
host-permission-declined error too). Settings API-key field links each
provider's key page (Gemini free tier called out) plus Ollama/LM Studio for
the no-key local path. Button-style radios stack vertically.

New in 0.4.9: third button style "tldw", a smaller TL;DW text pill (32px, the
user's ask: "shorter button, a little smaller"). buttonStyle is now
"text" (default) | "tldw" | "icon", normalized everywhere via normStyle.
Options page shows all three with previews. Also hardened options load():
getDefaults falls back to {} if the background page is still starting (cold
install race; it made smoke-options flake).

User confirmed on-phone (2026-07-11): the 2.5s play tip shows and the flow
works; "functionally what we have works fine". 0.4.6 burned by phone signing.

New in 0.4.8 (button placement + style): desktop button now goes in the OWNER
row, right of Subscribe (ytd-watch-metadata #owner, appended), because current
YouTube layouts stretch children injected into the like/share cluster into a
full-width row of their own (the user's "way wider than the text, above the
thumb" report). Old action-row hosts remain as fallbacks (prepend). The chip
CSS is stretch-proof (flex 0 0 auto, width auto, nowrap). New "Summarize
button style" setting on the options page with live previews: "text" (default)
or compact round "icon" chip (TL;DW mark; icons/icon-48.png is now a
web_accessible_resource). Radio saves instantly (storage.local buttonStyle);
the content script listens on storage.onChanged and swaps the live button in
place. Mobile keeps the slim-bar prepend; the icon variant is the one likely
to fit inline there.

New in 0.4.7: browser_action default_title is now just "Return YouTube
Summary". It was "...: summarize this video", and Firefox's unified extensions
panel labels the row with the ACTION title, so users saw "Return YouTube
Summary: s..." truncated. Also documented the play-to-load quirk in README
("Known quirk") and the AMO listing description (SUBMISSION.md).

New in 0.4.5: diagnostics above; mobile playback-capture window 15s -> 35s
(field trace showed the caption fetch lagging the give-up); the transcript
panel-poke phase is now desktop-only (on m.youtube.com it just expanded the
description sheet in the user's face, could never work, and wasted ~13s).

New in 0.4.6 (THE mobile fix): the 2.5s play tip now shows UNCONDITIONALLY on
m.youtube.com while the transcript is pending. It was gated on video.paused,
and the muted nudge flips paused to false while real playback never starts
(autoplay block), so the tip suppressed itself exactly when needed; the field
trace's "playing: true" with a stalled video is this. Desktop keeps the
paused gate. A real user tap on play pulls the transcript within a beat and
the flow continues automatically (capture polling runs the whole time).

Version bookkeeping (the only copy of this rule): AMO version numbers are
unique per add-on id ACROSS channels, so every unlisted-signed phone build
burns a number. 0.4.1-0.4.3 and 0.4.6 are burned; the public listing upload is
0.4.7, or the next bump if 0.4.7 gets sideload-signed first (bump `version` in
`src/manifest.json` + `package.json`, rebuild).

New in 0.4.3: if the transcript is still fetching after 2.5s and the video is
paused (autoplay blocked, so the muted nudge did nothing), the panel shows a
terse tip to press play; user-confirmed that playing pulls the capture
immediately. The total-failure error on mobile now leads with "play for a few
seconds, retry" before the desktop-site advice.

New in 0.4.4:
- Panel is dropped on SPA navigation on MOBILE too. Desktop always had this
  via yt-navigate-finish, but m.youtube.com never fires it, so the old video's
  panel used to ride along to the next page. The button MutationObserver now
  doubles as a URL-change detector, gated on the video id actually changing
  (chapter/timestamp URL rewrites must not remove the panel).
- Per-tab in-memory summary cache (videoId -> summary + Q&A turns), 30 min
  sliding TTL, max 10 entries, never persisted. Returning to a summarized
  video and tapping Summarize restores summary AND chat instantly, no LLM
  call. The qa array is shared by reference with the cache entry, so new
  follow-ups persist automatically. Note: within the TTL, Summarize restores
  rather than regenerates; a "regenerate" affordance is a possible later add.
- Settings page footnote links feedback/bug reports to the GitHub repo issues.

Verified end-to-end on desktop (real key, user-confirmed) and via the mock-LLM
smoke tests. Features: one-click Summarize; transcript via network intercept
(get_transcript + timedtext capture); OpenAI-compatible + native Anthropic with
SSE streaming; follow-up Q&A; long-video chunking (map-reduce); collapsible panel
(tap TL;DW header to fold to a bottom bar, summary preserved); native tonal-chip
button styling; visible API key with Show/Hide toggle. Lint 0 errors; all smokes
pass. Icons: green TL;DW mark at 48/96/128/512.

(The v0.4.1 "confirm the muted playback nudge on a real device" thread is
retired: field testing showed the muted nudge does not reliably trigger the
caption fetch, and the shipped answer is the unconditional play tip above.)

## Getting a build

```
npm run build      # -> dist/return_youtube_summary-<ver>.zip  (UNSIGNED; same package for desktop + Android)
# Private sideload copy (your phone / sharing), NOT for the public listing:
web-ext sign --api-key=<issuer> --api-secret=<secret> --channel=unlisted --source-dir src --artifacts-dir dist
```

- Desktop testing: `about:debugging` , Load Temporary Add-on , pick the zip.
- Android: signed install via the debug-menu "Install extension from file". See
  `MOBILE-TESTING.md` (release Firefox needs the signed xpi; the debug menu is
  unlocked by tapping the logo in About).
- `dist/` is gitignored, so builds live only on the build machine (scp them down).

## NEXT: publish to AMO (public listing). Steps remaining, all on the user side

Full listing copy + reviewer notes are in `SUBMISSION.md`. Short version:

1. **Account prep:** addons.mozilla.org , sign in , enable **2FA** (required) ,
   accept the one-time Add-on Distribution Agreement.
2. **Listed vs unlisted:** the public listing is a DIFFERENT upload from the
   `web-ext sign --channel=unlisted` xpi. For the listing you upload the
   **UNSIGNED build zip** through the Developer Hub and Mozilla signs it after
   review. The unlisted xpi is only the private sideload copy.
3. **Developer Hub , open the EXISTING add-on entry** (created by the unlisted
   signing; still displayed as "yap-sum" there, the listing name gets fixed in
   the form) **, Upload New Version , channel "On this site" , upload
   `dist/return_youtube_summary-<ver>.zip`.** Do NOT "Submit a New Add-on";
   the id already exists and would be rejected as a duplicate. Automated
   validation runs (passes). Answer No to the source-code question: the zip IS
   the unminified source.
4. **Fill the listing** from `SUBMISSION.md`: name (Return YouTube Summary),
   summary, description, category (Search Tools), tags, license (MIT),
   **screenshots** (user is gathering: button in the action row, settings page,
   and a real summary using their own key; a fall-of-Rome doc was suggested as
   generically safe), and the **Notes to reviewer** block (justifies webRequest,
   persistent background, optional host permission, and the anthropic header).
5. **Privacy policy:** paste `PRIVACY.md` text into the form's privacy-policy
   field, or link the file in the public repo.
6. **Submit for review** (automated + possibly human, a few days). Likely
   reviewer questions (webRequest use; "YouTube" in the name) are pre-answered in
   the reviewer notes. Precedent for the name: "Return YouTube Dislike" is listed.

(Version-uniqueness rule: see "Version bookkeeping" in the state section above.)

## Open work (tracked as tasks in-session)

- Fit the Summarize button inline on mobile (currently makes its own row);
  needs on-device iteration.
- Mobile fallback for videos that yield nothing even with playback: Tier 1
  (playback nudge) shipped; Tier 2 is a hidden desktop iframe of the watch page
  (strip X-Frame-Options, frame-scoped desktop UA, capture via existing
  intercept), to build after signing. Needed because the transcript is
  attestation-gated, so a plain background fetch cannot mint the token.

## Test and verify

Canonical command list lives in docs/DEVELOPMENT.md; kept here for resume
convenience:

```
node test/smoke-full.mjs [VIDEO_ID]      # authoritative: click , extract , (mock LLM) , summary , follow-up , collapse
YAPSUM_CHUNK=1 node test/smoke-full.mjs  # long-video chunking path
node test/smoke-options.mjs              # settings page
node test/smoke-ui.mjs                   # button injection
npm run emulator && npm run test:android # device-free Android
web-ext lint --source-dir src            # 0 errors (4 benign min-version warnings)
```

Tests run the real source inside a normal Firefox via `web-ext` (never
WebDriver; YouTube detects and blocks marionette).

## Repo push gotcha (important)

Origin is `git@github.com:NaLG/yt-sum.git`. The repo's `git config
core.sshCommand` forces the yt-sum deploy key (`~/.ssh/deploy_key_yt-sum`) and
bypasses the ssh-agent, which otherwise shadows it with another repo's key
(github then denies the push, reporting the wrong repo). With that config, plain
`git push` works. To verify the right identity:
`GIT_SSH_COMMAND="ssh -i ~/.ssh/deploy_key_yt-sum -o IdentitiesOnly=yes -o IdentityAgent=none" ssh -T git@github.com`
should say "Hi NaLG/yt-sum!".

## Extraction: the hard-won lessons (do not relearn these)

See `docs/EXTRACTION.md` and the code comments. In short: reconstructing
`get_transcript` returns 400 and fetching `timedtext` ourselves returns an empty
200 (both attestation/PoToken gated). The only reliable path is to let YouTube's
own player make the request and capture the response at the network layer
(`webRequest.filterResponseData`), keyed by video id. Two sources: the classic
panel's `get_transcript` JSON and the player's `/api/timedtext` caption track.
Desktop nudges the panel/CC to fire it; mobile needs playback (above). Fallbacks:
DOM-panel scrape, reconstruction, timedtext. The "PAmodern" A/B panel never
populates (its get_panel has no segments) and only fires timedtext ~10s after a
close/reopen, which content.js handles.
