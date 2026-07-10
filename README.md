# Return YouTube Summary

**The AI-summary button YouTube only *sometimes* gives you, made permanent, and
powered by your own LLM.** One click summarizes any video from its transcript, in
Firefox on desktop **and Android**, using **your own** API key. No backend, no
account, no tracking. The only thing that leaves your browser is the transcript
you send to the endpoint you chose.

YouTube has been rolling out its own "Ask AI" / AI-summary feature, but it's an
on-again/off-again experiment, present for some videos, some accounts, some
days, gone the next. This gives you that capability reliably, on every video,
with the model *you* pick (including local models that never leave your machine).

## Features

- **One-click Summarize** button in YouTube's action row (desktop and mobile).
- **Bring your own key:** any OpenAI-compatible endpoint, native Anthropic, or a
  local model (Ollama / LM Studio).
- **Follow-up Q&A:** ask questions about the video, grounded in its transcript.
- **Long videos** are summarized in parts, then synthesized into one summary.
- **Collapsible panel:** fold the result to a bottom bar and reopen it instantly.
- **Safe rendering:** summaries are formatted via `textContent`, never raw HTML.

## How it works

1. A content script on `youtube.com` / `m.youtube.com` injects a **Summarize**
   button (the toolbar popup triggers the same flow, handy on Android).
2. On click it obtains the transcript (see *Extraction* below) and hands it to the
   background script.
3. The background script calls your configured LLM endpoint with your system
   prompt and streams the summary into an in-page panel.

Your API key lives in `storage.local` and is only ever sent to the endpoint you
choose. See [PRIVACY.md](PRIVACY.md).

## Providers (bring your own key)

Configure in Settings. Two shapes cover essentially everything:

- **OpenAI-compatible** (`/v1/chat/completions`): OpenAI, GLM/Z.ai, Google Gemini
  (OpenAI-compat endpoint), OpenRouter, Groq, and local **Ollama** / **LM Studio**.
- **Anthropic** (native `/v1/messages`): Claude models directly.

> Why BYO key and not "sign in with your subscription"? As of 2026 Anthropic
> **prohibits and server-side-blocks** third-party apps using Claude subscription
> OAuth, and OpenAI's "Sign in with ChatGPT" is confined to their own products.
> An API key is the only sanctioned path, and for summarization it's nearly free.

## Extraction, the load-bearing design

Getting the transcript is the hard part, and the approach is **counter to most
guides**. Empirically (mid-2026), the usual recipes fail:

- **`timedtext`** (captionTracks baseUrl) is PoToken-gated, returns an **empty
  HTTP 200**.
- **Reconstructing the `get_transcript` POST** returns **400 `failedPrecondition`**
  everywhere, YouTube gates it on an attestation only its own player mints.

What works: **let YouTube's own player make the request, and capture its response
at the network layer** with `webRequest.filterResponseData` in the background, 
immune to page CSP and independent of how the transcript is rendered. Two sources
are captured (keyed by video id): the classic panel's `get_transcript` JSON and
the player's `/api/timedtext` caption track. On desktop the extension nudges the
transcript/captions to fire; on **mobile** it briefly starts playback (muted,
then restores the video) because the mobile player only fetches the transcript
once playback begins. Fallbacks: DOM-panel scrape → reconstruction → timedtext.
See `src/background/background.js` and `src/content/`.

> Mobile note: `m.youtube.com` exposes no transcript UI, so the extension relies
> on the network-intercept path there. A signed install keeps the `webRequest`
> permission it needs; see [MOBILE-TESTING.md](MOBILE-TESTING.md).

## Develop & test

```sh
npm install
npm run lint                         # web-ext lint (0 errors)
npm run run:desktop                  # launch in desktop Firefox on a test video
node test/smoke-full.mjs [VIDEO_ID]  # AUTHORITATIVE full path: click → extract →
                                     #   (mock LLM) → rendered summary → follow-up
YAPSUM_CHUNK=1 node test/smoke-full.mjs   # exercise the long-video chunking path
node test/webext-validate.mjs        # extraction-only, in real Firefox
npm run build                        # -> dist/<name>-<version>.zip
```

Tests run the **real** source inside a normal Firefox via `web-ext` (never
WebDriver, YouTube detects and blocks marionette) and relay results to a
localhost server.

### Android (device or device-free emulator)

```sh
npm run emulator                     # boot a headless emulator, provisioned for tests
npm run test:android                 # extraction test on the emulator/device
npm run run:android                  # launch on a USB-connected phone
```

See [MOBILE-TESTING.md](MOBILE-TESTING.md) for installing on a real phone and the
signing path.

## Publishing

[SUBMISSION.md](SUBMISSION.md) is the AMO submission kit, listing copy, data
disclosure, reviewer notes, and the build/sign steps.

## Layout

```
src/
  manifest.json             MV2 (Mozilla's recommendation for Firefox Android)
  content/
    extractor.js            transcript parsing (page-context; also test-imported)
    content.js              button injection, summarize + follow-up flow, panel UI
    content.css             injected styles (light/dark, mobile bottom-sheet)
  background/background.js   network intercept + LLM providers + SSE streaming
  options/                  settings page + toolbar popup
  icons/                    48/96/128/512 (green "TL;DW" mark)
test/
  smoke-full.mjs            authoritative end-to-end test (extract → summary → Q&A)
  webext-validate.mjs       extraction test (desktop + android)
  probe-*.mjs               probes used to characterize YouTube's transcript variants
scripts/                    android emulator + device launchers
```

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 nalg.
