# Architecture

How Return YouTube Summary works, in one place. Dev workflow lives in
docs/DEVELOPMENT.md, transcript-extraction research in docs/EXTRACTION.md,
release process in SUBMISSION.md. Code comments are deliberately near zero
(lint-enforced by test/lint-style.mjs): behavior belongs in code and tests,
rationale lives here.

## Components

MV2 extension, desktop + Android Firefox, no backend.

- `src/background/background.js`: persistent event page. Captures transcripts
  at the network layer and runs all LLM calls.
- `src/content/extractor.js`: locates and normalizes transcript data across
  YouTube's page variants.
- `src/content/content.js`: page orchestrator. Injects the Summarize button,
  owns the TL;DW panel (model picker, cache, waiting state, Q&A), talks to
  the background over a runtime port.
- `src/options/`: settings page (model comboboxes, extra models, host grants)
  and the toolbar popup (summarize trigger + settings link; the popup is the
  primary Android entry point).

## Transcript capture (background)

YouTube gates `get_transcript` and `timedtext` behind a PoToken attestation
only its own player can mint, so the extension never fetches them itself.
Blocking webRequest listeners force `Accept-Encoding: identity` on those two
endpoints and copy response bodies via `filterResponseData` while passing
them through to the player. Captures land in `capturedByVideo`, keyed by
video id and pruned on every capture (10 minute TTL, 20 entry cap: the page
is persistent, and without the cap a long captions-on session accumulates one
transcript per video watched, forever). `timedtext` captures never set the
un-keyed `lastCapture` fallback: related-video previews fetch OTHER videos'
captions and would poison it. The content script requests captures via
runtime messages and can force a caption fetch by toggling CC or nudging
playback.

## LLM calls (background)

Two provider shapes, OpenAI-compatible `chat/completions` and native
Anthropic `messages`, both streamed over SSE. `callLLM` tracks the
finish/stop reason; truncation and content-filter stops surface to the panel
as notices (reasoning models spend `max_tokens` on hidden thinking, so a
truncation otherwise looks like a silent stall). A 120s no-data watchdog
aborts dead connections; in-stream error events throw. Config resolution:
flat defaults merged with storage, then an optional `extraModels` entry
overlays provider/baseUrl/model/apiKey. The main API key is never sent to a
non-main endpoint, enforced in `getConfig` AND at options save. Long
transcripts go map-reduce: per-part notes, then one streaming synthesis call.

## Panel (content)

The Summarize button injects next to the like control; a MutationObserver
re-adds it through YouTube's SPA rebuilds, and a URL watcher covers
m.youtube.com, which never fires `yt-navigate-finish`. At content-script
startup any UI left by a previous script generation is removed: Firefox
injects updated scripts into already-open tabs, and the old button's
listeners died with its sandbox, so updates self-heal without a page reload.

The panel bar hosts the model chip (a native select, always rendered; its
list arrives via a sanitized `getModels` message carrying labels and model
ids only, never keys, with a direct-storage fallback for update version
skew). Summaries cache per `videoId::modelSig`, so changing models always
re-runs and flipping back is instant. Cache entries are stored by reference
and mutated in place: waiting entries gain transcripts, qa arrays grow.

With `autoSummarize` off, a cache miss parks the panel in a waiting state:
an explicit run button, with model switching and ask-first both working and
nothing billed until the user acts. Mobile transcripts only surface during
playback, so summarize and the waiting-state ask both trigger a playback
nudge synchronously inside the user gesture (an await first would drop the
gesture context) and undo it afterward.

All model output enters the DOM via `textContent` only; `renderMarkdown`
builds elements and never assigns model text to innerHTML.

## Options page

Model fields are plain-DOM comboboxes over a shared catalog (curated
fallback until a live `/models` load; each extra-model row can load its own
endpoint's catalog, kept row-local). Matching ranks exact substring hits
first, then ordered split matches (`kimi3` finds `kimi-k3`). Option picks
use mousedown, which wins against the input's blur. Extra-model rows
prefill endpoint and key from the main settings; a row on a foreign endpoint
must carry its own key; a row with a label but no model id refuses to save
(silently dropping it once made the picker "mysteriously" never appear).
All needed host origins go into ONE `permissions.request` per save: the
click gesture is consumed by the first prompt, and any await before it drops
the gesture. Origin patterns use protocol + hostname, never `URL.origin`,
because match patterns cannot carry a port (Ollama on :11434). Narrow
viewports stack the label/model fields on full-width rows.

## Frozen identifiers

The AMO listing is live. These must never change: gecko id
`return-youtube-summary@nalg.dev`, `yapsum-*` CSS classes and DOM ids,
storage keys, and the local dir / npm name `yap-sum`. Test signs go to the
separate `yap-sum@nalg.dev` Hub entry (swap the manifest id temporarily) so
store version numbers are never burned; every AMO upload consumes its
version number forever within that id.

## Test gate

`node test/run-all.mjs` runs 9 checks: web-ext lint; style lint (comment
budget + em-dash ban); leak bounds (drives the real background.js in a VM
through 200 synthetic captures and asserts the collection caps hold); four
real-Firefox suites (geckodriver options page, button placement, shorts
exclusion, mock-LLM end to end, live-YouTube extraction); and a
leaked-browser assertion. web-ext does not reliably kill Firefox and runs it
on a profile COPY under `os.tmpdir()`, so every suite reaps tmpdir-profile
Firefoxes at teardown and the gate FAILS if any survive. Test launches set
`app.update.disabledForTesting` (a staged Firefox app update otherwise
wedges every fresh launch mid-apply). Two harness rules: test-helper
`onMessage` listeners must stay synchronous, because an async listener
claims every message's response channel and races the real handlers; and
WebDriver element clicks, never `.click()`, wherever a real user gesture
gates an API (`permissions.request`). The mock LLM echoes `model=<id>` into
its replies so panel text proves which model served it, and screenshots land
in `test/artifacts/` for human review.
