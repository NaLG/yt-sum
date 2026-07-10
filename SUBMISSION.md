# AMO submission kit for Return YouTube Summary

Everything needed to submit a **listed** public release on addons.mozilla.org.
Publisher/developer display name: **nalg**. Add-on name: **Return YouTube Summary**.
(The internal manifest `id` stays `yap-sum@nalg.dev`; it is not user-visible and
must never change once published.)

## Listing copy (paste into the AMO submission form)

- **Name:** Return YouTube Summary
- **Summary** (≤250 chars): The AI-summary button YouTube only sometimes gives
  you, made permanent, and run on your own key. One click summarizes any video
  from its transcript, with follow-up Q&A. No backend, no tracking; your data
  goes only to the provider you choose.
- **Description:**
  > YouTube has started rolling out its own "Ask AI" / AI-summary button, but
  > it's an on-again, off-again experiment: there for some videos, some accounts,
  > some days, and gone the next. Return YouTube Summary gives you that capability
  > **reliably, on every video**, with the model *you* choose.
  >
  > Click Summarize and it reads the current video's transcript and summarizes it
  > through the LLM endpoint you configure with your own API key, so you control
  > the model and where your data goes. There is no developer server; nothing is
  > collected.
  >
  > • Bring your own key: any OpenAI-compatible endpoint, native Anthropic, or a
  >   local model (Ollama / LM Studio) that never leaves your machine.
  > • Ask follow-up questions about the video, based on its transcript.
  > • Long videos are summarized in parts, then combined.
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

> Return YouTube Summary summarizes YouTube videos through a user-supplied LLM API key. No
> developer server exists. Points a reviewer may want:
>
> 1. **Source is exactly as shipped.** No minifier, bundler, or transpiler, the
>    package is the `src/` folder zipped (`web-ext build`). Files are hand-written
>    and readable; no build step is required to reproduce the artifact.
> 2. **`webRequest` + `webRequestBlocking` on youtube.com** are used to READ
>    YouTube's own transcript/caption responses (`/youtubei/v1/get_transcript`
>    and `/api/timedtext`) at the network layer, the only reliable way to obtain
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

- [x] Final name applied, "Return YouTube Summary" (manifest, PRIVACY.md, this file)
- [x] Icons added, 48/96/128/512 from the green TL;DW logo, referenced in manifest
- [ ] `PRIVACY.md` hosted; URL in the listing
- [ ] Version bumped; `web-ext lint` shows 0 errors
- [ ] Screenshots attached
- [x] License chosen, MIT (`LICENSE`)
