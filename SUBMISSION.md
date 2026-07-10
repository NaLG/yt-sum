# AMO submission kit — yap-sum

Everything needed to submit a **listed** public release on addons.mozilla.org.
Publisher/developer display name: **nalg**.

> **Name is not final.** This kit uses "yap-sum" as a placeholder. Once the final
> name is chosen, update it here, in `src/manifest.json` (`name`), `PRIVACY.md`,
> and the store listing copy below. The manifest `id` (`yap-sum@nalg.dev`) can
> stay as-is — it's an internal identifier, not shown to users.

## Listing copy (paste into the AMO submission form)

- **Name:** yap-sum _(placeholder — final name TBD)_
- **Summary** (≤250 chars): One-click AI summaries of YouTube videos using your
  own LLM API key. No backend, no tracking — the transcript goes only to the
  provider you choose (OpenAI, Gemini, Anthropic, OpenRouter, Groq, or a local
  model). Includes follow-up Q&A and long-video handling.
- **Description:**
  > yap-sum adds a Summarize button to YouTube. Click it and it grabs the
  > current video's transcript and summarizes it through the AI endpoint you
  > configure with your own API key — so you decide the model, the cost, and
  > where your data goes. There is no yap-sum server; nothing is collected by
  > the developer.
  >
  > • Bring your own key: any OpenAI-compatible endpoint, native Anthropic, or a
  >   local model (Ollama / LM Studio).
  > • Ask follow-up questions about the video, grounded in its transcript.
  > • Long videos are summarized in parts, then synthesized.
  > • Works on desktop and Firefox for Android.
  > • Summaries render as clean, safe formatted text (never raw HTML injection).
- **Category:** Search Tools _(alt: Other)_
- **Tags:** youtube, summary, ai, llm, transcript, productivity
- **Support / homepage:** the GitHub repository (publisher **nalg**).
- **Privacy policy:** host `PRIVACY.md` (e.g. in the GitHub repo) and paste its
  URL into the "Privacy policy" field, or paste the text directly.
- **License:** MIT (see `LICENSE`).

## Data collection disclosure (must match the manifest)

Declared in `browser_specific_settings.gecko.data_collection_permissions.required`:

| Category | Why | Destination |
|---|---|---|
| `websiteContent` | The video transcript + title are transmitted for summarization | The user's own configured LLM endpoint only |
| `authenticationInfo` | The user's API key is sent as the request credential | The user's own configured LLM endpoint only |

No `technicalAndInteraction` (no telemetry/analytics of any kind). Nothing is
transmitted to the developer; there is no backend.

## Reviewer notes (paste into "Notes to reviewer")

> yap-sum summarizes YouTube videos through a user-supplied LLM API key. No
> developer server exists. Points a reviewer may want:
>
> 1. **Source is exactly as shipped.** No minifier, bundler, or transpiler — the
>    package is the `src/` folder zipped (`web-ext build`). Files are hand-written
>    and readable; no build step is required to reproduce the artifact.
> 2. **`webRequest` + `webRequestBlocking` on youtube.com** are used to READ
>    YouTube's own transcript/caption responses (`/youtubei/v1/get_transcript`
>    and `/api/timedtext`) at the network layer — the only reliable way to obtain
>    a transcript, since the endpoints are gated behind an attestation only
>    YouTube's player mints. The extension does not modify page content; it only
>    forces `Accept-Encoding: identity` on those requests so the response can be
>    read as plain text. See `src/background/background.js`.
> 3. **Persistent background page** is required because MV2 event pages cannot
>    register blocking `webRequest` listeners.
> 4. **Optional `https://*/*` permission** is opt-in and used solely so a user can
>    point the extension at a custom LLM endpoint they enter themselves. The
>    always-granted host permissions are limited to YouTube and the named
>    provider APIs.
> 5. **`anthropic-dangerous-direct-browser-access` header** is Anthropic's
>    sanctioned header for browser-based BYO-key requests.
> 6. **No remote code / no eval.** All model output is inserted with
>    `textContent` (see `renderMarkdown` in `src/content/content.js`), so summary
>    text cannot inject HTML.
>
> **How to test:** install, open the extension's settings, choose a provider and
> paste an API key (e.g. a free Google Gemini key via the OpenAI-compatible base
> URL preset), open any YouTube video, and click **Summarize**.

## Screenshots to attach

- Desktop: the Summarize button in the action row + a rendered summary panel.
- Mobile: `docs/mobile-summarize-button.png` (already in repo).
- The settings page (provider presets + model dropdown).

## Build & sign

```
# bump src/manifest.json + package.json version first (AMO rejects a re-used version)
npm run build                          # -> dist/<name>-<version>.zip  (unsigned)

# Listed submission: upload the zip in the AMO Developer Hub "Submit a New Add-on"
# flow (channel: "On this site"), fill the listing fields above, submit for review.

# (For a self-distributed signed build instead of listing:)
web-ext sign --api-key=<issuer> --api-secret=<secret> --channel=unlisted \
  --source-dir src --artifacts-dir dist
```

## Pre-submit checklist

- [ ] Final name applied in manifest `name`, `PRIVACY.md`, and this file
- [ ] 128×128 icon added (`src/icons/icon-128.png`) and referenced in manifest `icons`
- [ ] `PRIVACY.md` hosted; URL in the listing
- [ ] Version bumped; `web-ext lint` shows 0 errors
- [ ] Screenshots attached
- [x] License chosen — MIT (`LICENSE`)
