# yap-sum — Handoff notes

Firefox extension (MV2, desktop + Android): one-click **AI summaries of YouTube
videos** using the user's **own LLM API key**. Repo: `/Users/clawd/repos/yap-sum`.

**Auth: BYO API key only, no OAuth.** Anthropic (and OpenAI) block third-party
apps from using subscription login for inference — settled, don't revisit.

## Current state

- **Works & tested:** button injection; **transcript via network intercept**
  (primary); OpenAI-compatible + Anthropic LLM call with SSE streaming;
  markdown→rich-text panel (injection-safe); options page (live `/models`
  dropdown + preset-endpoint chips). Lint clean.
- **Unverified:** the **scrape fallback** — headless Firefox renders transcripts
  differently (virtualized, odd layout), so it can't be tested faithfully here;
  relies on the user's real browser + the debug bundle. Also: real remote-LLM
  output (tests use a mock server).
- **Pending:** Android emulator loop ("B", not started — physical-device path is
  wired); long-transcript (2h+) chunking; follow-up-questions feature.
- Last build handed to user: `sha 34afc9a…` (scoping + rich-text fix). Their
  failing videos: `31MvP7yHzxM`, `tVnOfWW89pA`. `ajfrOBs_mNk` worked earlier.

## Transcript extraction (the expensive lesson — keep this)

YouTube gates the transcript endpoints behind a PoToken only its own player can
mint. Established empirically (mid-2026):

- **Reconstructing `get_transcript` ourselves → 400 failedPrecondition.** Dead.
- **`timedtext` → empty 200 (PoToken-gated).** Dead.
- **Toggling the panel to force a re-fetch → also 400.** Removed; was harmful.
- **What works:** let the player fetch it and **capture the JSON at the network
  layer** (`webRequest.filterResponseData`, background). Primary, gives full
  transcript. Keyed by videoId (decoded from request params).
- **Scrape fallback** must be **scoped to the transcript panel** (found by
  `target-id*=transcript` / "Transcript" header). Unscoped, it grabbed
  related-video/chapter timestamps — which also fooled `openTranscriptPanel`
  into not triggering the fetch, breaking the intercept too (the root cause of
  the repeated user failures). The panel is virtualized, so the scraper scrolls
  it and accumulates rows.
- **Env facts:** WebDriver/marionette is detected+blocked by YouTube (use
  `web-ext`, not geckodriver, for extraction tests). Users are on different
  YouTube A/B markup variants — detection must be structure-based, not tag-based.

## Files

- `src/content/extractor.js` — page-context transcript logic (no WebExtension
  APIs; test-importable). `globalThis.yapSum`: extract/scrape/panel helpers.
- `src/content/content.js` — `getTranscript()` flow (passive capture → scrape
  visible → last-resort open+close), button injection, `renderMarkdown`
  (textContent-only, injection-safe), error panel + **Copy debug info** button.
- `src/background/background.js` — network intercept/capture + the LLM call
  (SSE streaming over a runtime port) + message handlers (incl. `getDebug`).
- `src/options/` — settings page (`options.*`) + toolbar popup (`panel.*`).
- `src/manifest.json` — MV2, `gecko` + `gecko_android`, provider host perms.

## Build / test / ship

```
npm run build            # -> dist/yap-sum-0.1.0.zip
node test/smoke-full.mjs # AUTHORITATIVE: click→extract→(mock LLM)→panel; asserts
                         #   full transcript reached the LLM + rich-text rendered
node test/smoke-options.mjs   # options: presets fill URL, dropdown fills model
web-ext lint --source-dir src
```

Tests use `web-ext` + a throwaway reporter extension that relays results to a
localhost HTTP server (content-script→background→localhost; YouTube CSP blocks
content-script localhost fetch). Content-script `console.log` does NOT reach
web-ext stdout — use the relay.

**User loads it** (they SSH in, run Firefox on their own machine): `scp` the zip
down → `about:debugging` → Load Temporary Add-on → pick the zip. Update = rebuild,
overwrite zip, **Reload** in about:debugging.

## Next

1. Confirm the intercept fix works on the user's real browser; if not, the
   **Copy debug info** bundle reports `transcriptPanelFound/Info`,
   `engagementPanelTargets`, `timestampRowSamples`, and the bg get_transcript
   request/response log — enough to fix precisely.
2. Android emulator loop (device-free). 3. Real-key content check.
4. Long-transcript chunking. 5. Follow-up questions.

## Working rule

Don't hand the user a build without a test reproducing their actual scenario.
The intercept path is testable; lean on it + the debug bundle, not guesses.
They dislike visual noise (opening the transcript panel) — prefer capture/scrape
without UI.
