# yap-sum

One-click AI summaries of YouTube videos, in Firefox on desktop **and Android**,
through **your own** LLM API key. No backend, no account, no tracking — the only
thing that leaves your browser is the transcript you send to the endpoint you
configured.

Built because YouTube keeps A/B-removing its own AI summaries, and watching
clickbait to find out whether a video is worth watching is a bad trade.

## Status

Early scaffold. Transcript extraction is **built and validated** end-to-end in
real Firefox (see below). The summarize UI, provider layer (OpenAI-compatible +
native Claude), and settings page are in place. Not yet published to AMO.

## How it works

1. A content script on `youtube.com` / `m.youtube.com` injects a **Summarize**
   button (and the toolbar popup can trigger the same flow — the Android entry).
2. On click it extracts the transcript (see *Extraction* below), then hands it to
   the background script.
3. The background script calls your configured LLM endpoint with your system
   prompt and streams the summary into an in-page panel.

Your API key lives in `storage.local` and is only ever sent to the endpoint you
choose.

## Providers (bring your own key)

Configure in Settings. Two shapes cover essentially everything:

- **OpenAI-compatible** (`/v1/chat/completions`): OpenAI, GLM/Z.ai
  (`glm-4.7-flash` is free), Gemini (OpenAI-compat endpoint), OpenRouter, Groq,
  and local **Ollama** / **LM Studio**.
- **Anthropic** (native `/v1/messages`): Claude models directly.

> Why BYO key and not "sign in with your subscription"? As of 2026 Anthropic
> **prohibits and server-side-blocks** third-party apps using Claude
> subscription OAuth, and OpenAI's "Sign in with ChatGPT" is confined to their
> own products. An API key is the only sanctioned path — and for
> summarization it's nearly free (a 30-min video is a fraction of a cent; GLM's
> flash tier is free).

## Extraction — why the DOM-scrape design

This is the load-bearing technical decision, and it's **counter to most guides**,
which recommend fetching `captionTracks[].baseUrl` (timedtext) or reconstructing
the InnerTube `get_transcript` POST. Empirically (mid-2026), both fail:

- **timedtext** is increasingly PoToken-gated: affected tracks (`exp=xpe`) return
  an **empty HTTP 200**.
- **get_transcript reconstruction** returns **400 `failedPrecondition`** in every
  environment we tested — headless, headed, with playback, logged-out, even with
  `navigator.webdriver === false`. YouTube gates it on an attestation only its
  own app produces.

But YouTube's **own "Show transcript" panel works** even in a clean logged-out
browser — its app makes the attested request internally and renders every
segment into the DOM (not virtualized). So yap-sum **triggers the panel and
scrapes the rendered segments**. Validated in real Firefox via `web-ext`:

| Video | Lines | Chars | Extract time |
|---|---|---|---|
| 10-min TED talk | 458 | ~21k | ~2s |
| 2-hour podcast | 4,404 | ~461k | ~6s |

The whole transcript comes back at once (it's a single request YouTube itself
makes — not streamed per playback position), so pulling it in one shot carries
**no extra rate-limit risk** beyond clicking "Show transcript" yourself. yap-sum
only extracts on demand, one video at a time — well under any observed threshold.

Fallback chain if the panel path ever fails: `get_transcript` (works in some
warmed/logged-in sessions) → legacy `timedtext`. See
`src/content/extractor.js`.

## Develop & test

```sh
npm install                      # web-ext
npm run lint                     # web-ext lint
npm run run:desktop              # launch in desktop Firefox on a test video
npm run test:extract             # AUTOMATED: validate extraction in real Firefox
```

`test:extract` is the automated validation loop: it runs the **real**
`extractor.js` inside a normal Firefox (via `web-ext`, no WebDriver — YouTube
detects and blocks WebDriver/marionette) and relays the result to a localhost
server. Pass video IDs to test specific videos:
`node test/webext-validate.mjs <id> <id>`.

### Android

One-time on the phone: enable **USB debugging** (Developer options) and Firefox →
Settings → **Remote debugging via USB**. Plug in over USB, accept the prompt.

```sh
npm run run:android              # launch the extension on the device
npm run test:android             # AUTOMATED extraction test on-device (via adb reverse)
```

The Android test tunnels the phone's localhost back to the Mac with
`adb reverse`, so the same validation runs on-device.

## Layout

```
src/
  manifest.json            MV2 (Mozilla's recommendation for Firefox Android)
  content/
    extractor.js           transcript extraction (page-context; also test-imported)
    content.js             button injection, summarize flow, panel UI
    content.css            injected styles (light/dark, mobile bottom-sheet)
  background/background.js  LLM providers + SSE streaming
  options/                 settings page + toolbar popup
test/
  webext-validate.mjs      authoritative extraction test (desktop + android)
  probe.mjs, *.mjs         Node/WebDriver probes used to characterize the
                           extraction problem (kept for regression/debugging)
scripts/run-android.mjs    launch on a USB device
```
