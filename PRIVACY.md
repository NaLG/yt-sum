Return YouTube Summary Privacy Policy

Last updated 2026-07-11. Publisher: nalg.

Short version: this extension has no servers and collects nothing for its developer. The only place your data goes is the LLM endpoint you configure.

What it does

The extension adds a Summarize button to YouTube watch pages. Clicking it reads the current video's transcript and sends it, with the video title, to the AI endpoint you configured in settings, using the API key you supplied. The summary is shown in a panel on the page. Follow-up questions send your question plus the transcript and prior answers to the same endpoint.

Data it handles, and where it goes

- Video transcript and title (website content): read from the YouTube page you are viewing and transmitted only to the endpoint you configured. Never sent to the developer or to any party you did not configure. This is the manifest's declared websiteContent collection.
- Your API key (authentication info): stored locally in the browser's extension storage and sent only to your configured endpoint, as the credential for your own requests. Never sent to the developer. This is the declared authenticationInfo collection.
- Your settings (provider, endpoint URL, model, system prompt, limits): stored locally on your device only.

There is no developer server. The extension makes network requests only to YouTube, to read the transcript of the page you are on, and to the endpoint you chose.

What it never does

- No analytics, telemetry, tracking, advertising, or fingerprinting.
- No collection of browsing history, identity, location, or contacts.
- No cookies, no selling or sharing data with anyone.
- No access to your YouTube account credentials; it reads the page, not your login.

Third-party providers

Because you choose the endpoint (OpenAI, Google Gemini, Anthropic, OpenRouter, Groq, a local model), the transcript and title you submit are processed under that provider's own privacy policy and terms. The extension has no control over what your chosen provider does with data you send it. Fully local models (Ollama, LM Studio) keep data on your machine.

Permissions

- Host access to youtube.com and m.youtube.com: adds the button and reads the transcript of the page you're viewing.
- webRequest: reads YouTube's own transcript and caption responses, the reliable way to obtain a transcript. Nothing outside YouTube's transcript requests is intercepted, and page content is not modified.
- Optional host access to LLM API endpoints: nothing is granted at install. When you configure a provider, Firefox asks you to allow access to that one host, and only it, so your requests can be sent there. The broad any-site option is likewise opt-in and exists for custom endpoints you enter yourself.
- storage: saves your settings and key locally.

Your control

Everything is local. Removing the extension deletes its stored settings and key. You can change or clear the endpoint and key at any time in settings.

Changes

Updates to this policy are published in the extension's source repository with a new date.

Contact

Open an issue on the project's GitHub repository (publisher nalg).
