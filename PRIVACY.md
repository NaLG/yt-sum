# Return YouTube Summary Privacy Policy

_Last updated: 2026-07-10. Publisher: **nalg**._

**Short version: Return YouTube Summary has no servers and collects nothing for its developer.
The only place your data goes is the LLM endpoint _you_ configure.**

## What Return YouTube Summary does

Return YouTube Summary adds a "Summarize" button to YouTube watch pages. When you click it, the
extension obtains the current video's transcript and sends it, with the video
title, to the AI/LLM API endpoint you configured in the extension's settings,
using the API key you supplied. The summary that comes back is shown in a panel
on the page. Optional follow-up questions send your question plus the transcript
and prior answers to the same endpoint.

## Data Return YouTube Summary handles, and where it goes

- **Video transcript and title (website content).** Read from the YouTube page
  you are viewing, using your existing browser session, and **transmitted only to
  the LLM endpoint you configured.** It is never sent to the developer or to any
  party you did not configure. Corresponds to the manifest's declared
  `websiteContent` data collection.
- **Your API key (authentication info).** Stored locally on your device via the
  browser's extension storage (`storage.local`) and **transmitted only to your
  configured endpoint**, as the authorization credential for your own requests.
  It is never sent to the developer. Corresponds to the declared
  `authenticationInfo` data collection.
- **Your settings** (provider, endpoint URL, model, system prompt, limits).
  Stored locally on your device only.

There is **no developer-operated server or backend**. Return YouTube Summary makes network
requests only to (a) YouTube, to read the transcript of the page you are on, and
(b) the LLM endpoint you chose.

## What Return YouTube Summary does NOT do

- No analytics, telemetry, tracking, advertising, or fingerprinting.
- No collection of browsing history, personal identity, location, or contacts.
- No cookies set by the extension; no data sold or shared with anyone.
- No access to your YouTube account credentials (it reads the page, not your
  login).

## Third-party LLM providers

Because you choose the endpoint (e.g. OpenAI, Google Gemini, Anthropic,
OpenRouter, Groq, a local model, etc.), **the transcript and title you submit are
processed under that provider's own privacy policy and terms.** Return YouTube Summary has no
control over what your chosen provider does with the data you send it. Please
review your provider's policy. For fully local models (e.g. Ollama, LM Studio),
data stays on your machine.

## Permissions, briefly

- **Host access to `youtube.com` / `m.youtube.com`**, to add the button and read
  the transcript of the page you're viewing.
- **`webRequest`**, to read YouTube's own transcript/caption network responses
  (the reliable way to obtain a transcript). Return YouTube Summary does not modify page content
  or intercept anything outside YouTube's transcript requests.
- **Host access to the LLM API hosts, and optional access to other origins**, 
  only so it can send your request to the endpoint you configure. The broad
  "any site" option is optional and used solely to allow a custom endpoint you
  enter yourself.
- **`storage`**, to save your settings and key locally.

## Your control

Everything is local and under your control. Removing the extension deletes its
locally stored settings and key. You can change or clear the endpoint and key at
any time in the extension's settings.

## Changes

If this policy changes, the updated version will be published in the extension's
source repository with a new "Last updated" date.

## Contact

Questions or concerns: open an issue on the project's GitHub repository
(publisher **nalg**).
