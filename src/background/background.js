// ============================================================================
// Transcript capture via network interception.
//
// YouTube gates get_transcript/timedtext behind a PoToken only its own player
// can mint, so we let the player make the request and capture the JSON response
// at the network layer with webRequest.filterResponseData. This is Firefox-
// native, immune to page CSP, and independent of how the transcript is rendered
// (no DOM scraping). The content script triggers the player (opens the panel);
// this captures whatever get_transcript response comes back.
// ============================================================================

const GT_URLS = ["*://*.youtube.com/youtubei/v1/get_transcript*"];
const capturedByTab = new Map(); // tabId -> { at, json }

// Force identity encoding on get_transcript so filterResponseData sees plain
// JSON (avoids brotli/gzip we can't decode in the filter).
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const requestHeaders = details.requestHeaders.filter(
      (h) => h.name.toLowerCase() !== "accept-encoding"
    );
    requestHeaders.push({ name: "Accept-Encoding", value: "identity" });
    return { requestHeaders };
  },
  { urls: GT_URLS },
  ["blocking", "requestHeaders"]
);

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Only capture the page's own player requests, not our own fallback fetches.
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const chunks = [];
    filter.ondata = (event) => {
      chunks.push(new Uint8Array(event.data));
      filter.write(event.data); // pass through so the player still works
    };
    filter.onstop = () => {
      filter.close();
      try {
        let total = 0;
        for (const c of chunks) total += c.length;
        const all = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        const text = new TextDecoder("utf-8").decode(all);
        const json = JSON.parse(text);
        if (JSON.stringify(json).includes("transcriptSegmentRenderer")) {
          capturedByTab.set(details.tabId, { at: Date.now(), json });
        }
      } catch {
        /* not parseable — ignore */
      }
    };
    filter.onerror = () => {};
    return {};
  },
  { urls: GT_URLS },
  ["blocking"]
);

// yap-sum background (event page) — runs the LLM call.
// Keeps the API key out of page context and centralizes provider logic.
// Two provider shapes:
//   - "openai": any OpenAI-compatible /v1/chat/completions endpoint
//     (OpenAI, GLM/Z.ai, Gemini OpenAI-compat, OpenRouter, Groq, Ollama, LM Studio)
//   - "anthropic": native Claude Messages API (/v1/messages)
// Streams tokens back to the content script over the connection port.

const DEFAULTS = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
  anthropicVersion: "2023-06-01",
  systemPrompt:
    "You summarize YouTube video transcripts. Produce a tight, skimmable summary: " +
    "a one-sentence TL;DR, then 5-10 bullet points of the key claims, facts, and takeaways " +
    "in the order they appear. Prefer concrete detail over generalities. Omit sponsor reads, " +
    "subscribe requests, and filler. If the video is a tutorial, capture the steps.",
  maxTokens: 1500,
  // Guard against pathological transcripts blowing past context windows / cost.
  // ~4 chars/token, so 320k chars ~= 80k tokens. Trim from the middle if longer.
  maxTranscriptChars: 320000,
};

async function getConfig() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

function trimTranscript(text, maxChars) {
  if (text.length <= maxChars) return text;
  // Keep the head and tail (intro + conclusion usually matter most); mark the cut.
  const half = Math.floor(maxChars / 2);
  return (
    text.slice(0, half) +
    "\n\n[… transcript trimmed for length …]\n\n" +
    text.slice(text.length - half)
  );
}

function buildUserPrompt(title, transcript) {
  return `Video title: ${title}\n\nTranscript (timestamps in brackets):\n\n${transcript}`;
}

// ---- provider request builders ----

function buildRequest(cfg, title, transcript) {
  const userPrompt = buildUserPrompt(title, transcript);
  if (cfg.provider === "anthropic") {
    return {
      url: `${cfg.baseUrl.replace(/\/$/, "")}/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": cfg.anthropicVersion,
        // Extensions bypass CORS via host permissions, but this header is the
        // sanctioned BYO-key browser path and harmless to include.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        system: cfg.systemPrompt,
        stream: true,
        messages: [{ role: "user", content: userPrompt }],
      },
      parse: parseAnthropicSSE,
    };
  }
  // OpenAI-compatible
  return {
    url: `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      stream: true,
      messages: [
        { role: "system", content: cfg.systemPrompt },
        { role: "user", content: userPrompt },
      ],
    },
    parse: parseOpenAISSE,
  };
}

// ---- SSE delta parsers: return the text delta from one SSE data line ----

function parseOpenAISSE(json) {
  return json?.choices?.[0]?.delta?.content || "";
}
function parseAnthropicSSE(json) {
  if (json?.type === "content_block_delta" && json.delta?.type === "text_delta") return json.delta.text || "";
  return "";
}

// ---- streaming driver ----

async function streamSummary(port, cfg, title, transcript) {
  const req = buildRequest(cfg, title, transcript);
  let res;
  try {
    res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
  } catch (e) {
    port.postMessage({ type: "error", error: `Network error reaching the LLM endpoint: ${e.message}` });
    return;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    port.postMessage({
      type: "error",
      error: `LLM endpoint returned ${res.status}. ${body.slice(0, 300)}`,
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines; process complete lines.
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        const delta = req.parse(json);
        if (delta) {
          full += delta;
          port.postMessage({ type: "chunk", text: delta });
        }
      }
    }
    port.postMessage({ type: "done", text: full });
  } catch (e) {
    port.postMessage({ type: "error", error: `Stream interrupted: ${e.message}` });
  }
}

// ---- port wiring ----

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "summarize") return;
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "summarize") return;
    const cfg = await getConfig();
    if (!cfg.apiKey) {
      port.postMessage({
        type: "error",
        error: "No API key configured. Open yap-sum settings and add your provider + API key.",
      });
      return;
    }
    const transcript = trimTranscript(msg.transcript, cfg.maxTranscriptChars);
    await streamSummary(port, cfg, msg.title || "Untitled", transcript);
  });
});

// Expose defaults to the options page, and serve captured transcripts to the
// content script.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "getDefaults") return Promise.resolve(DEFAULTS);
  const tabId = sender.tab?.id;
  if (msg?.type === "armCapture") {
    // Clear any stale capture from a previous video in this tab.
    if (tabId != null) capturedByTab.delete(tabId);
    return Promise.resolve({ armed: true });
  }
  if (msg?.type === "getCaptured") {
    const cap = tabId != null ? capturedByTab.get(tabId) : null;
    // Only serve a fresh capture (guards against SPA nav races).
    if (cap && Date.now() - cap.at < 120000) return Promise.resolve({ json: cap.json });
    return Promise.resolve({ json: null });
  }
});
