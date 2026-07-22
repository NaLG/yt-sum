# AMO submission kit for Return YouTube Summary

Everything needed to submit a **listed** public release on addons.mozilla.org.
Publisher/developer display name: **nalg**. Add-on name: **Return YouTube Summary**.
(Internal manifest `id`: `return-youtube-summary@nalg.dev`, live at 0.5.0
since 2026-07-11; it must never change again. The old `yap-sum@nalg.dev`
entry is renamed "-test" in the Hub and serves as the sideload/testing
channel only.)

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
  > • Note: some videos only expose their transcript once playback starts; the
  >   panel prompts you to press play and then continues automatically.
- **Category:** Search Tools _(alt: Other)_
- **Tags:** youtube, summary, ai, llm, transcript, productivity
- **Support / homepage:** the GitHub repository (publisher **nalg**).
- **Privacy policy:** host `PRIVACY.md` (e.g. in the GitHub repo) and paste its
  URL into the "Privacy policy" field, or paste the text directly.
- **License:** AGPL-3.0-only (see `LICENSE`; matches the license selected on
  the AMO listing).

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
> 4. **All LLM hosts are `optional_permissions`** (least privilege): the only
>    install-time host permissions are the two YouTube origins. When the user
>    configures a provider, the settings page requests access to that single
>    host at Save / Test connection (a user gesture); `https://*/*` is likewise
>    optional and exists solely for custom endpoints the user types themselves.
> 5. **`anthropic-dangerous-direct-browser-access` header** is Anthropic's
>    sanctioned header for browser-based BYO-key requests.
> 6. **No remote code / no eval.** All model output is inserted with
>    `textContent` (see `renderMarkdown` in `src/content/content.js`), so summary
>    text cannot inject HTML.
>
> **How to test:** install, open the extension's settings, choose a provider and
> paste an API key (e.g. a free Google Gemini key via the OpenAI-compatible base
> URL preset), open any YouTube video, and click **Summarize**.

## 0.5.2 version submission (2026-07-15)

**Release notes (paste into the version's "Release notes" field):**

> Panel and Shorts update. No permission changes.
>
> - The summary panel is now movable and resizable on desktop: drag the title
>   bar to move it, drag any edge or corner to resize it. Clicking the title
>   bar still collapses it, and it remembers its spot as you browse.
> - New setting "Collapse in place": the panel folds up to just its title bar
>   right where it sits, instead of docking to the bottom corner.
> - New setting: an optional Summarize button on Shorts (off by default), a
>   round button in the Shorts action rail. Note: many Shorts have no
>   captions; those cannot be summarized.
> - Summarizing a Short from the extension menu now works whenever the Short
>   has captions (the old blanket refusal is gone).

**Reviewer notes delta (prepend to the standing notes above):**

> Changes in 0.5.2 vs 0.5.1 are UI-only; full diff:
> https://github.com/NaLG/yt-sum/compare/fc5723a...08bcc40
>
> - Summary panel is now movable/resizable on desktop: pointer-event drag on
>   the panel title bar plus edge/corner resize grips, all in
>   src/content/content.js and content.css. No new APIs.
> - New collapseInPlace setting (options page): folds the panel in place
>   instead of docking it to the corner.
> - New shortsButton setting (default OFF): a round Summarize button in the
>   Shorts action rail; the extension-menu summarize path now also works on
>   Shorts with captions.
> - Manifest change: version only. No new permissions, hosts, or APIs.
>
> Quick test without any API key: open a YouTube video, click Summarize; the
> panel appears (a "no API key" error is fine) and can be dragged by its
> title bar and resized from its edges and corners. The two new settings are
> on the options page.

## 0.5.4 version submission (2026-07-22)

**Release notes (paste into the version's "Release notes" field):**

> Model picker and streaming reliability fixes. No new install-time
> permissions.
>
> - New: extra models. In settings, add more models. They reuse your main
>   endpoint and key by default, or each can bring its own. The summary
>   panel then shows a subtle model picker so you can re-run the same video
>   through a deeper, cheaper, or just different model. Follow-up questions
>   go to whichever model wrote the summary they are about, and the panel
>   names the model it is summarizing with.
> - The model fields now filter as you type, and each extra model can load
>   the live model catalog from its own endpoint. The panel's model chip is
>   always shown, so you can see which model will run, and every model
>   (including the default) can carry a short label of your choosing.
> - Model search matches split queries: typing kimi3 finds kimi-k3, and
>   gemini35 finds gemini-3.5-flash. Exact matches always list first.
> - The settings page reads better on narrow screens: the label and model
>   fields each get a full row.
> - New setting "Auto-summarize" (on by default, matching old behavior).
>   Turned off, the Summarize button opens the panel in a waiting state: pick
>   a model or ask a question first, and nothing is billed until you click
>   "Summarize this video".
> - Fixed: granting access to a local endpoint with a port (e.g. Ollama on
>   localhost:11434) could fail; ports are now handled correctly.
> - Fixed: after an extension update, YouTube tabs that were already open
>   kept a dead Summarize button until manually reloaded. Updates now clean
>   up and rebuild the UI in open tabs on their own.
> - Fixed: changing the model in settings now always takes effect. Before,
>   re-summarizing a video you had already summarized could silently serve
>   the previous model's cached summary.
> - Fixed: summaries that stopped partway through and never finished on
>   reasoning models (e.g. Google Gemini Flash): those models spend the
>   output-token budget on hidden thinking, so the visible summary was cut
>   off silently. The default budget is now larger, and if a summary is
>   still cut short the panel says so and points at the setting to raise.
> - If the provider stops a summary early (content filter), the panel now
>   shows a note instead of ending silently.
> - A dead connection now fails with a clear error after two minutes of
>   silence instead of leaving the panel frozen.

**Reviewer notes delta (prepend to the standing notes above):**

> Changes in 0.5.4 vs 0.5.2 are confined to the LLM call path, its settings,
> and the panel's new model picker. The diff also carries a repo-wide comment
> removal and test-only tooling (test/, never shipped in the package); full
> diff: https://github.com/NaLG/yt-sum/compare/08bcc40...dc9d6f4
>
> - src/background/background.js: streaming reader now tracks the provider's
>   finish/stop reason and reports truncation or content-filter stops to the
>   panel as a "notice" message; a 120s no-data watchdog (AbortController)
>   aborts dead connections; in-stream error events throw instead of being
>   skipped; stream timings land in the existing debug ring buffer. Default
>   maxTokens raised from 1500 to 4000 (reasoning models spend the same
>   budget on hidden thinking). New: extraModels list in storage.local; a
>   summarize request may name one entry, whose non-empty fields override
>   the main settings. The main API key is never sent to an endpoint other
>   than the main one (enforced in getConfig AND at save time).
> - src/options/options.{html,js,css}: "Extra models" section. Rows are
>   prefilled with the main endpoint/key; a row pointing at a different
>   endpoint must have its own key. All needed origins are requested in ONE
>   permissions.request call on Save (same user-gesture flow as before; all
>   LLM hosts remain optional_permissions). The model <select> was replaced
>   by a plain-DOM type-to-filter combobox (shared by the main field and the
>   rows); each row can load the live /models catalog from its own endpoint.
>   Origin patterns are now built from protocol + hostname instead of
>   URL.origin, because match patterns cannot carry a port (fixes runtime
>   grants for local endpoints like Ollama on :11434).
> - src/content/content.js + content.css: a native select in the panel bar
>   (always rendered, showing the active model) re-summarizes with the picked
>   model; summary cache is now keyed per model, which is the cache fix
>   above. New autoSummarize setting (default on, the old behavior): turned
>   off, the panel parks with an explicit run button before any LLM call.
>   The picker list arrives via a sanitized getModels message (labels
>   and model ids only, never keys). Notices render as a muted line via
>   textContent only (injection safe, same as all model output). On startup
>   the script removes any button/panel left by a previous script generation
>   (Firefox injects the updated script into open tabs; the old UI's
>   listeners are dead), so updates heal open tabs without a reload.
> - test/smoke-full.mjs: mock LLM records every request's model + auth
>   header; suite asserts the model switch propagates, the picker drives
>   requests with the entry's own key, and the truncation notice renders.
> - Manifest change: version only. No new permissions, hosts, or APIs.

## Screenshots to attach

- Desktop: the Summarize button left of the like control + a rendered summary panel.
- Mobile: capture fresh; `docs/mobile-summarize-button.png` is STALE (predates
  the left-of-like placement and the current styles).
- The settings page (provider presets, model dropdown, button-style picker).

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

## Status (2026-07-11)

- [x] Name, icons, license, privacy policy text, listing copy, reviewer notes: all submitted
- [x] Listed version submitted (identity verification pending, see note at top)
- [ ] Listing icon uploaded on Edit Product Page (src/icons/icon-128.png; AMO ignores manifest icons)
- [ ] Screenshots attached (capture fresh, see above)
- [ ] Homepage / support-site fields (github repo) on Edit Product Page
