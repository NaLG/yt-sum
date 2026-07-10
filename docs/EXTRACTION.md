# Transcript extraction

Getting the transcript is the hard part of this extension, and the approach is
counter to most guides you'll find. This doc records what fails, what works, and
the quirks that took real effort to learn, so nobody has to relearn them.

## What fails (empirically, mid-2026)

The two "documented" recipes both dead-end:

- **`timedtext`** (the `captionTracks[].baseUrl` from player data) is
  PoToken-gated. Fetching it yourself returns an **empty HTTP 200**: no error,
  no body.
- **Reconstructing the `get_transcript` POST** (`/youtubei/v1/get_transcript`
  with a hand-built params blob) returns **400 `failedPrecondition`**
  everywhere. YouTube gates it on an attestation token that only its own player
  mints; there is no way to fabricate it from an extension.

The consequence: any approach where the extension makes its *own* request for
the transcript is dead. The requests must come from YouTube's player itself.

## What works: capture the player's own traffic

Let YouTube's own player make the request, and capture its response at the
network layer with `webRequest.filterResponseData` in the background script.
This is immune to page CSP and independent of how (or whether) the transcript
is ever rendered in the DOM.

Two sources are captured, keyed by video id:

1. The classic transcript panel's `get_transcript` JSON.
2. The player's `/api/timedtext` caption track.

The intercept also forces `Accept-Encoding: identity` on those requests so the
response body can be read as plain text.

To make the player actually fire those requests:

- **Desktop:** the content script nudges the transcript panel / captions into
  loading.
- **Mobile (`m.youtube.com`):** the mobile player only fetches the transcript
  once playback begins, so on tap the extension starts playback muted
  **synchronously within the click gesture** (a later `play()` is rejected by
  autoplay policy once anything has been awaited), captures the transcript,
  then pauses and rewinds the video. Desktop is unaffected (hostname gated).

## Fallback chain

If the network capture yields nothing, the extension falls back in order:

1. DOM scrape of the transcript panel (desktop only; mobile has no panel UI).
2. `get_transcript` reconstruction.
3. Direct `timedtext` fetch.

The fallbacks are kept because they cost little and YouTube's gating has
changed before, but as of mid-2026 only the network capture works reliably.

## Mobile notes

`m.youtube.com` exposes no transcript UI at all, so mobile relies entirely on
the network-intercept path. A signed install keeps the `webRequest` permission
it needs; see [MOBILE-TESTING.md](../MOBILE-TESTING.md).

## Quirks worth remembering

- The "PAmodern" A/B variant of the transcript panel never populates: its
  `get_panel` response contains no segments. It only fires a `timedtext`
  request roughly 10 seconds after the panel is closed and reopened, which
  `content.js` handles.
- Tests must run in a normal Firefox via `web-ext`, never WebDriver: YouTube
  detects and blocks marionette.

## Where the code lives

- `src/background/background.js`: the network intercept, plus LLM providers.
- `src/content/`: the nudges, DOM fallback, and parsing (`extractor.js`).
- `test/probe*.mjs`: the probes used to characterize YouTube's transcript
  variants and establish the failure modes above.
