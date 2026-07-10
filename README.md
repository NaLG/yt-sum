# Return YouTube Summary

YouTube has been rolling out its own "Ask AI" / AI-summary feature, but it's an
on-again/off-again feature, present for some videos, some accounts, some
days, gone the next. This gives you that capability reliably, on every video.

One click summarizes any video from its transcript, in
Firefox on desktop and Android, using your own API key. No backend, no
account, no tracking. The only thing that leaves your browser is the transcript
you send to the endpoint you chose.


## Features

- **One-click Summarize** button in YouTube's action row.
- **Bring your own key:** any OpenAI-compatible endpoint, eg OpenRouter/z.ai, or a
  local model (Ollama / LM Studio).
- **Follow-up Q&A:** ask questions about the video, based on its transcript.
- **Long videos** are summarized in parts, then combined into one.
- **Collapsible panel:** fold the result to a bottom bar and reopen it instantly.
- **Safe rendering:** summaries are formatted via `textContent`, never raw HTML.

## Providers (BYOK)

Your API key lives in `storage.local` and is only ever sent to the endpoint you
choose. See [PRIVACY.md](PRIVACY.md).

Configure in Settings. Two shapes cover essentially everything:

- **OpenAI-compatible** (`/v1/chat/completions`): OpenAI, GLM/Z.ai, Google Gemini
  (OpenAI-compat endpoint), OpenRouter, Groq, and local **Ollama** / **LM Studio**.
- **Anthropic** (native `/v1/messages`): Claude models directly.

> Why BYO key and not "sign in with your subscription"?  Because we're all tired and sick of Subscription culture.  Stop paying for Subscriptions.  Pay only pennies for the inference/hardware required, let software be free.

## Technical details on Extraction

Getting the transcript is the hard part: the endpoints most guides describe are
now gated behind an attestation only YouTube's own player can produce. So the
extension doesn't make its own requests; it lets YouTube's player fetch the
transcript and captures the response at the network layer in the background
script. The full story (what fails, what works, and the mobile wrinkles) is in
[docs/EXTRACTION.md](docs/EXTRACTION.md).

## Known quirk

Some videos (mostly on Android) only expose their transcript once playback
starts. If fetching stalls, the panel says so: press play, and the summary
continues on its own within a second or two.

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
docs/                       EXTRACTION.md (how transcripts are captured) + screenshots
scripts/                    android emulator + device launchers
```

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 nalg.
