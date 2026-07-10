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

## OPEN INVESTIGATION: mobile empty timedtext (2026-07-11, v0.4.5)

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

## Current state: v0.4.7, release-ready

User confirmed on-phone (2026-07-11): the 2.5s play tip shows and the flow
works; "functionally what we have works fine". 0.4.6 burned by phone signing.

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

Version bookkeeping: 0.4.1-0.4.3 were consumed (or reserved) by unlisted
signing for phone testing; AMO version numbers are unique per add-on id across
channels, so the public listing upload is 0.4.4+.

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

### One thing still needing a real-device confirm

The **mobile playback nudge** (v0.4.1). On m.youtube.com the player only fetches
the transcript once playback starts, so a cold Summarize found nothing. Fix: on
tap we start playback muted **synchronously within the click gesture** (a later
play() is rejected by autoplay policy once we have awaited anything), capture the
transcript, then pause and rewind the video. Desktop is unaffected (hostname
gated). The emulator was too ANR-unstable to auto-confirm; it rests on the user's
manual repro ("play then Summarize works") which this automates. Test on a real
phone: a video that failed cold should now summarize without pressing play first.

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
3. **Developer Hub , Submit a New Add-on , "On this site" (listed) , upload
   `dist/return_youtube_summary-<ver>.zip`.** Automated validation runs (passes).
4. **Fill the listing** from `SUBMISSION.md`: name (Return YouTube Summary),
   summary, description, category (Search Tools), tags, license (MIT),
   **screenshots** (user is gathering: button in the action row, settings page,
   and a real summary using their own key; a fall-of-Rome doc was suggested as
   generically safe), and the **Notes to reviewer** block (justifies webRequest,
   persistent background, optional host permission, and the anthropic header).
5. **Privacy policy:** easiest is to paste `PRIVACY.md` text into the form's
   privacy-policy field (no hosting needed). Or make the repo public and link it.
6. **Submit for review** (automated + possibly human, a few days). Likely
   reviewer questions (webRequest use; "YouTube" in the name) are pre-answered in
   the reviewer notes. Precedent for the name: "Return YouTube Dislike" is listed.

**Version-uniqueness gotcha:** AMO requires each version number to be unique per
add-on id. If 0.4.1 was already `web-ext sign`ed (unlisted), the listed upload of
0.4.1 will be rejected as a duplicate. In that case bump to 0.4.2 and rebuild
before uploading (change `version` in `src/manifest.json` and `package.json`).

## Open work (tracked as tasks in-session)

- Confirm the v0.4.1 mobile playback fix on a real phone (above).
- Fit the Summarize button inline on mobile (currently makes its own row);
  needs on-device iteration.
- Mobile fallback for videos that yield nothing even with playback: Tier 1
  (playback nudge) shipped; Tier 2 is a hidden desktop iframe of the watch page
  (strip X-Frame-Options, frame-scoped desktop UA, capture via existing
  intercept), to build after signing. Needed because the transcript is
  attestation-gated, so a plain background fetch cannot mint the token.

## Test and verify

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
