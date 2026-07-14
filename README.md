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

## Getting started

1. Install the extension (coming to addons.mozilla.org; until then, build from
   source via [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).
2. Click the toolbar icon and open **Settings**: pick a provider and paste an
   API key. New to API keys? The settings page links each provider's key page.
   Google Gemini has a free tier, and local models (Ollama / LM Studio) need no
   key at all.
3. Open any YouTube video and hit **Summarize**. Ask follow-up questions right
   in the panel.

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

## For developers

Build, test, and release docs live in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

AGPL-3.0-only, see [LICENSE](LICENSE). Copyright (c) 2026 nalg.
