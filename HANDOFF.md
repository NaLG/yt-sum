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

## Current state: v0.4.1, working

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

See README "Extraction" and the code comments. In short: reconstructing
`get_transcript` returns 400 and fetching `timedtext` ourselves returns an empty
200 (both attestation/PoToken gated). The only reliable path is to let YouTube's
own player make the request and capture the response at the network layer
(`webRequest.filterResponseData`), keyed by video id. Two sources: the classic
panel's `get_transcript` JSON and the player's `/api/timedtext` caption track.
Desktop nudges the panel/CC to fire it; mobile needs playback (above). Fallbacks:
DOM-panel scrape, reconstruction, timedtext. The "PAmodern" A/B panel never
populates (its get_panel has no segments) and only fires timedtext ~10s after a
close/reopen, which content.js handles.
