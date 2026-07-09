# yap-sum — Handoff notes

Firefox extension (MV2, desktop + Android): one-click **AI summaries of YouTube
videos** using the user's **own LLM API key**. Repo: `/Users/clawd/repos/yap-sum`.

**Auth: BYO API key only, no OAuth.** Anthropic (and OpenAI) block third-party
apps from using subscription login for inference — settled, don't revisit.

## Current state (v0.3.0, 2026-07-10)

- **CONFIRMED WORKING by the user on desktop with a real key (Gemini).**
- **Works & tested end-to-end (mock LLM):** button injection; transcript via
  network intercept — BOTH `get_transcript` (classic panel) AND
  **`/api/timedtext` (caption-track) capture**; OpenAI-compatible + Anthropic
  SSE streaming; markdown→rich-text panel (injection-safe); options page;
  **long-transcript chunking** (map-reduce: per-part notes → synthesis, with
  "part i/N" progress in the panel; `chunkChars` default 100k, `maxChunks` 10,
  0 disables); **follow-up Q&A field** under the summary (sends transcript +
  summary + prior turns; streamed markdown answers; YouTube hotkeys shielded).
- The formerly failing videos (`31MvP7yHzxM`, `tVnOfWW89pA`) pass
  `test/smoke-full.mjs` — root cause was the "PAmodern" panel variant (below).
- **Android:** device-free emulator loop DONE (`npm run emulator` →
  `npm run test:android`). Extraction verified in Fenix 152 on the emulator
  (desktop-site UA). m.youtube.com itself has NO transcript surface — mobile
  users need "Request desktop site" (content.js shows that hint on failure).
- **Pending:** AMO unlisted signing (the path to REAL Android installs — Fenix
  has no about:debugging and strips webRequest from temp add-ons). After that:
  hidden desktop-iframe extraction on m.youtube.com (user-approved backlog
  idea: iframe the desktop watch page invisibly, strip X-Frame-Options +
  frame-scoped desktop UA via webRequest, existing intercept captures the
  transcript, summary renders in our own mobile panel — no overlay needed).

## Transcript extraction (the expensive lessons — keep ALL of this)

YouTube gates transcript endpoints behind attestation/PoTokens only its own
player can mint. Established empirically (mid-2026):

- **Reconstructing `get_transcript` → 400. Fetching `timedtext` ourselves →
  empty 200. Both dead in every environment.** The ONLY working approach:
  trigger the player/panel and **capture its own requests at the network layer**
  (`webRequest.filterResponseData` in the background).
- **Two capturable sources** (both keyed by videoId, `capturedByVideo`):
  1. `get_transcript` JSON — fired when the CLASSIC transcript panel opens.
  2. `/api/timedtext` — the player's caption-track fetch (full track in ONE
     response, json3). Parsed by `NS.parseTimedtextBody` (json3 + srv XML).
- **"PAmodern_transcript_view" A/B variant** (the user's failing videos):
  "Show transcript" opens a panel that NEVER populates — its `get_panel`
  response carries no segments and YouTube's own UI spins forever. No
  `get_transcript` is ever fired. BUT ~10s after a panel **close/reopen** the
  player fetches the full `timedtext` — content.js nudges the panel (max 2×)
  and polls captures up to ~40s (`modernPanel()` in content.js).
- **lastCapture fallback is get_transcript-ONLY.** Related-rail inline previews
  fetch timedtext for OTHER videos constantly; an un-keyed fallback served a
  preview's captions as the current video's transcript (subtle wrong-output bug).
- **Panel/button detection must be structure-based and multi-candidate:**
  transcript button can be `button`/`yt-button-shape`/`[role=button]`/`a`
  (aria-label first, then short text); several `[target-id*=transcript]`
  containers can coexist (empty PAmodern stub + populated classic) — scan ALL
  candidates and keep the one with rows.
- **captionTracks parsing needs balanced-bracket extraction** — the lazy regex
  truncated on `name.runs` (nested `}]`), which the mobile player response uses.
  `getBootstrap` must per-field MERGE DOM + refetched bootstraps (the refetched
  m.youtube page is a JS shell that would erase DOM-found fields).
- **MV2 + blocking webRequest needs `persistent: true`** (manifest changed).
- **Env facts:** WebDriver is detected by YouTube (use `web-ext`, never
  geckodriver). Fresh test profiles often have CC on by default → passive
  timedtext capture at page load (why smoke runs report `captions-intercept`).

## Android (device-free loop — WORKING)

- `npm run emulator` (scripts/android-emulator.sh): boots headless AVD
  (android-35 google_apis arm64, `adb root` works), installs Fenix 152 release,
  enables Remote Debugging by editing `fenix_preferences.xml` as root (no UI!),
  sets `open_links_in_apps=never`, disables the YouTube app, and writes
  `general.useragent.override` (desktop UA) into the Gecko profile's user.js.
- `npm run test:android` then validates real extraction in Fenix.
- **Gotchas:** web-ext's `--start-url` is unsupported on Android — the harness
  fires a VIEW intent after "Installed ... as a temporary add-on" appears.
  **Fenix strips API permissions (webRequest!) from TEMPORARY add-ons** (host
  origins survive) — so the intercept path can't be harness-tested on Android;
  panel-scrape is what validates there. Real (signed/AMO) installs get the
  permission prompt → webRequest works. `adb` from the homebrew cask hangs at
  exec on this Mac — use the SDK's platform-tools (android-env.sh handles it).
- m.youtube.com probes: `test/probe-mobile.mjs` (markup/anchors/timedtext),
  `test/probe-desktop.mjs` (PAmodern timeline + network capture). Keep both —
  they're the discovery tools for the next YouTube variant.

## Files

- `src/content/extractor.js` — page-context transcript logic (no WebExtension
  APIs; test-importable). `globalThis.yapSum`: extract/scrape/panel helpers +
  `parseTimedtextBody`/`parseGetTranscriptJson`/`findTranscriptButton`.
- `src/content/content.js` — `getTranscript()` flow: passive capture → visible
  scrape → CC-toggle trigger → panel open (+PAmodern nudge) → network fallbacks.
  Button injection, `renderMarkdown` (injection-safe), error panel + Copy debug
  info (+ "Request desktop site" hint on m.youtube.com).
- `src/background/background.js` — get_transcript + timedtext intercepts
  (`collectBody`), `callLLM` (SSE over runtime port), chunked `streamSummary`
  (map-reduce) + `streamFollowup`, `getDebug` ring buffer.
- `scripts/android-env.sh`, `scripts/android-emulator.sh` — the Android loop.
- `src/options/` — settings page + toolbar popup.

## Build / test / ship

```
npm run build                      # -> dist/yap-sum-0.3.0.zip
node test/smoke-full.mjs [VIDEO]   # AUTHORITATIVE full path incl. follow-up Q&A
YAPSUM_CHUNK=1 node test/smoke-full.mjs   # chunked map-reduce mode (tiny chunks)
node test/smoke-full.mjs 31MvP7yHzxM   # the PAmodern regression
node test/webext-validate.mjs      # extractor-only (desktop); PAmodern videos
                                   #   FAIL here by design (need bg intercept)
npm run emulator && npm run test:android   # Android loop
web-ext lint --source-dir src      # 0 errors (4 min-version warnings, benign)
```

**User loads it** (they SSH in, run Firefox on their own machine): `scp` the zip
→ `about:debugging` → Load Temporary Add-on. Update = rebuild, overwrite zip,
**Reload** in about:debugging.

## Next

1. Hand v0.3.0 to the user (chunking + follow-up Q&A are new since their
   confirmed-working v0.2.0).
2. AMO unlisted signing (free account + API keys; `web-ext sign`) → real
   Android installs. 3. Then the hidden desktop-iframe mobile idea (task #6).

## Working rule

Don't hand the user a build without a test reproducing their actual scenario.
They dislike visual noise — capture passively where possible; the CC toggle and
panel nudge are the accepted minimum. Headless Firefox is unreliable for
scrape/scroll testing; the intercept path IS testable — lean on it + probes.
