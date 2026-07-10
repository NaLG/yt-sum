// ============================================================================
// Transcript capture via network interception.
//
// YouTube gates get_transcript/timedtext behind a PoToken only its own player
// can mint, so we let the player make the request and capture the response
// at the network layer with webRequest.filterResponseData. This is Firefox-
// native, immune to page CSP, and independent of how the transcript is rendered
// (no DOM scraping). Two capturable sources:
//   - get_transcript: fired when the CLASSIC transcript panel opens.
//   - /api/timedtext: fired whenever the player turns captions on. On the
//     "PAmodern_transcript_view" A/B variant the panel uses get_panel (whose
//     response carries NO segments, YouTube's own panel just spins), so the
//     caption fetch is the only working source there. The content script can
//     force it by toggling CC.
// ============================================================================

const GT_URLS = ["*://*.youtube.com/youtubei/v1/get_transcript*"];
const TT_URLS = ["*://*.youtube.com/api/timedtext*"];
const capturedByVideo = new Map(); // videoId -> { at, kind, json?, text? }
let lastCapture = null; // most recent, as a fallback when videoId can't be decoded

// ---- diagnostics ring buffer ------------------------------------------------
const START = Date.now();
const DBG = [];
function dbg(m, extra) {
  const e = { dt: Date.now() - START, m, ...(extra || {}) };
  DBG.push(e);
  if (DBG.length > 300) DBG.shift();
  try { console.log("[yap-sum:bg]", m, extra || ""); } catch {}
}
dbg("background loaded; webRequest available", { has: typeof browser.webRequest?.filterResponseData === "function" });

// The get_transcript request body carries a base64 `params` protobuf whose
// first field is the 11-char video id. Decode it so captures are keyed by
// video, this way an already-fetched transcript (opened before Summarize, or
// preloaded) is matched without needing to re-open the panel.
function videoIdFromParams(params) {
  try {
    const bin = atob(String(params).replace(/-/g, "+").replace(/_/g, "/"));
    if (bin.charCodeAt(0) === 0x0a && bin.charCodeAt(1) === 0x0b) {
      const id = bin.slice(2, 13);
      if (/^[\w-]{11}$/.test(id)) return id;
    }
    const m = bin.match(/[\w-]{11}/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

// Force identity encoding on captured endpoints so filterResponseData sees
// plain text (avoids brotli/gzip we can't decode in the filter).
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const requestHeaders = details.requestHeaders.filter(
      (h) => h.name.toLowerCase() !== "accept-encoding"
    );
    requestHeaders.push({ name: "Accept-Encoding", value: "identity" });
    return { requestHeaders };
  },
  { urls: [...GT_URLS, ...TT_URLS] },
  ["blocking", "requestHeaders"]
);

// Shared response-body collector for a request being filtered.
function collectBody(requestId, onText, onErr) {
  const filter = browser.webRequest.filterResponseData(requestId);
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
      onText(new TextDecoder("utf-8").decode(all));
    } catch (e) {
      onErr?.(e);
    }
  };
  filter.onerror = () => dbg("filter error", { err: filter.error });
}

// Capture the player's own caption fetches. The URL carries v=<videoId>, and
// the response is the FULL track in one shot (json3 or srv XML).
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const videoId = (details.url.match(/[?&]v=([\w-]{11})/) || [])[1] || null;
    // pot = the player attached its attestation token. An empty body WITH pot
    // means YouTube gated the player itself (bad); without pot it's just the
    // probe variant and a pot-carrying retry may follow.
    let q = null;
    try { q = new URL(details.url).searchParams; } catch {}
    dbg("timedtext request seen", { videoId, pot: !!q?.has("pot"), fmt: q?.get("fmt") ?? null, kind: q?.get("kind") ?? null, lang: q?.get("lang") ?? null });
    collectBody(
      details.requestId,
      (text) => {
        dbg("timedtext response", { bytes: text.length, videoId, first60: text.slice(0, 60) });
        // Empty 200s are the PoToken-gated variant, the player retries with
        // attestation; only keep bodies that actually contain caption events.
        // NEVER set lastCapture here: related-rail inline previews fetch
        // timedtext for OTHER videos all the time, and the un-keyed fallback
        // would serve their captions as the current video's transcript.
        if (text.length > 50 && videoId) {
          capturedByVideo.set(videoId, { at: Date.now(), kind: "timedtext", text });
        }
      },
      (e) => dbg("timedtext capture error", { err: String(e) })
    );
    return {};
  },
  { urls: TT_URLS },
  ["blocking"]
);

// Diagnostic: status + cache facts for the captured endpoints. A 200 that
// filterResponseData saw as 0 bytes but arrived fromCache/service-worker
// means the real body exists and is simply invisible to the filter.
browser.webRequest.onCompleted.addListener(
  (d) =>
    dbg("completed", {
      ep: d.url.includes("timedtext") ? "timedtext" : "get_transcript",
      status: d.statusCode,
      fromCache: !!d.fromCache,
      videoId: (d.url.match(/[?&]v=([\w-]{11})/) || [])[1] || null,
    }),
  { urls: [...GT_URLS, ...TT_URLS] }
);

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    let videoId = null;
    let bodyOk = false;
    try {
      const raw = details.requestBody?.raw?.[0]?.bytes;
      if (raw) {
        videoId = videoIdFromParams(JSON.parse(new TextDecoder().decode(raw)).params);
        bodyOk = true;
      }
    } catch {
      /* no/unparseable body, fall back to lastCapture */
    }
    dbg("get_transcript request seen", { videoId, bodyOk, method: details.method });

    collectBody(
      details.requestId,
      (text) => {
        let json = null, parseErr = null;
        try { json = JSON.parse(text); } catch (e) { parseErr = String(e); }
        const hasSegs = !!json && JSON.stringify(json).includes("transcriptSegmentRenderer");
        dbg("get_transcript response", { bytes: text.length, first80: text.slice(0, 80), parseErr, hasSegs, videoId });
        if (hasSegs) {
          const entry = { at: Date.now(), kind: "get_transcript", json };
          lastCapture = entry;
          if (videoId) capturedByVideo.set(videoId, entry);
        }
      },
      (e) => dbg("get_transcript capture error", { err: String(e) })
    );
    return {};
  },
  { urls: GT_URLS },
  ["blocking", "requestBody"]
);

function getCapturedFor(videoId) {
  // Keyed entries stay valid until pruned (transcripts don't change).
  const byId = videoId && capturedByVideo.get(videoId);
  if (byId) return byId;
  // Fallback (get_transcript only, see timedtext capture note): a very fresh
  // capture whose params we couldn't decode is almost certainly the one the
  // caller just triggered by opening the panel.
  if (lastCapture && Date.now() - lastCapture.at < 20000) return lastCapture;
  return null;
}

// Keep the map from growing without bound.
function pruneCaptures() {
  const cutoff = Date.now() - 600000;
  for (const [k, v] of capturedByVideo) if (v.at < cutoff) capturedByVideo.delete(k);
}

// yap-sum background (event page), runs the LLM call.
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
  buttonStyle: "text", // "text" chip or compact "icon" chip on YouTube
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
  // Transcripts longer than chunkChars are summarized map-reduce style:
  // per-part notes, then one synthesis call. ~100k chars ≈ 25k tokens/call,
  // safe for small-context models. 0 disables chunking (trim-only behavior).
  chunkChars: 100000,
  maxChunks: 10,
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

function buildRequest(cfg, system, messages) {
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
        system,
        stream: true,
        messages,
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
      messages: [{ role: "system", content: system }, ...messages],
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

// One streaming LLM call. Returns the full text; onDelta fires per chunk.
// Throws with a user-presentable message on any failure.
async function callLLM(cfg, system, messages, onDelta) {
  const req = buildRequest(cfg, system, messages);
  let res;
  try {
    res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
  } catch (e) {
    throw new Error(`Network error reaching the LLM endpoint: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM endpoint returned ${res.status}. ${body.slice(0, 300)}`);
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
          onDelta?.(delta);
        }
      }
    }
  } catch (e) {
    throw new Error(`Stream interrupted: ${e.message}`);
  }
  return full;
}

// Split at line boundaries into <= maxChunks roughly equal parts.
function splitTranscript(text, targetChars, maxChunks) {
  const nChunks = Math.min(maxChunks, Math.max(2, Math.ceil(text.length / targetChars)));
  const per = Math.ceil(text.length / nChunks);
  const parts = [];
  let cur = [], curLen = 0;
  for (const line of text.split("\n")) {
    cur.push(line);
    curLen += line.length + 1;
    if (curLen >= per && parts.length < nChunks - 1) {
      parts.push(cur.join("\n"));
      cur = []; curLen = 0;
    }
  }
  if (cur.length) parts.push(cur.join("\n"));
  return parts;
}

const PART_SYSTEM =
  "You take dense notes on one PART of a longer video transcript. Capture the topics, claims, " +
  "facts, figures, names, and steps in order, tersely, as bullet points. Omit sponsor reads and " +
  "filler. No commentary about the notes themselves.";

async function streamSummary(port, cfg, title, transcript) {
  // Long transcript → map-reduce: per-part notes, then one synthesis call that
  // streams to the panel. Keeps every call within small-model context windows.
  if (cfg.chunkChars > 0 && transcript.length > cfg.chunkChars * 1.2) {
    const capped = trimTranscript(transcript, cfg.chunkChars * cfg.maxChunks);
    const parts = splitTranscript(capped, cfg.chunkChars, cfg.maxChunks);
    const notes = [];
    for (let i = 0; i < parts.length; i++) {
      port.postMessage({ type: "stage", text: `Long transcript, summarizing part ${i + 1}/${parts.length}…` });
      notes.push(
        await callLLM(cfg, PART_SYSTEM, [
          { role: "user", content: `Video title: ${title}\n\nTranscript PART ${i + 1} of ${parts.length} (timestamps in brackets):\n\n${parts[i]}` },
        ])
      );
    }
    port.postMessage({ type: "stage", text: `Synthesizing summary from ${parts.length} parts…` });
    const synthesis =
      `Video title: ${title}\n\nThe video's transcript was processed in ${parts.length} sequential parts. ` +
      `Notes for each part, in order:\n\n` +
      notes.map((n, i) => `--- Part ${i + 1} notes ---\n${n}`).join("\n\n") +
      `\n\nWrite the final summary of the WHOLE video from these notes.`;
    const full = await callLLM(cfg, cfg.systemPrompt, [{ role: "user", content: synthesis }], (d) =>
      port.postMessage({ type: "chunk", text: d })
    );
    port.postMessage({ type: "done", text: full });
    return;
  }

  const userPrompt = buildUserPrompt(title, trimTranscript(transcript, cfg.maxTranscriptChars));
  const full = await callLLM(cfg, cfg.systemPrompt, [{ role: "user", content: userPrompt }], (d) =>
    port.postMessage({ type: "chunk", text: d })
  );
  port.postMessage({ type: "done", text: full });
}

const FOLLOWUP_SYSTEM =
  "You answer follow-up questions about a YouTube video, grounded in its transcript (provided in the " +
  "first message). If the transcript doesn't cover the question, say so briefly. Answer in tight markdown.";

async function streamFollowup(port, cfg, msg) {
  const messages = [
    { role: "user", content: buildUserPrompt(msg.title || "Untitled", trimTranscript(msg.transcript || "", cfg.maxTranscriptChars)) },
    { role: "assistant", content: msg.summary || "(no summary)" },
  ];
  for (const turn of msg.qa || []) {
    messages.push({ role: "user", content: turn.q });
    messages.push({ role: "assistant", content: turn.a });
  }
  messages.push({ role: "user", content: msg.question });
  const full = await callLLM(cfg, FOLLOWUP_SYSTEM, messages, (d) => port.postMessage({ type: "chunk", text: d }));
  port.postMessage({ type: "done", text: full });
}

// ---- port wiring ----

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "summarize") return;
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "summarize" && msg.type !== "followup") return;
    const cfg = await getConfig();
    if (!cfg.apiKey) {
      port.postMessage({
        type: "error",
        error: "No API key configured. Open yap-sum settings and add your provider + API key.",
      });
      return;
    }
    try {
      if (msg.type === "summarize") await streamSummary(port, cfg, msg.title || "Untitled", msg.transcript);
      else await streamFollowup(port, cfg, msg);
    } catch (e) {
      port.postMessage({ type: "error", error: e.message });
    }
  });
});

// Expose defaults to the options page, and serve captured transcripts to the
// content script.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "getDefaults") return Promise.resolve(DEFAULTS);
  if (msg?.type === "armCapture") {
    pruneCaptures();
    return Promise.resolve({ armed: true });
  }
  if (msg?.type === "getCaptured") {
    const cap = getCapturedFor(msg.videoId);
    dbg("getCaptured", { videoId: msg.videoId, hit: !!cap, kind: cap?.kind });
    // json kept for the older content-script shape; capture carries the kind.
    return Promise.resolve({ json: cap?.kind === "get_transcript" ? cap.json : null, capture: cap ? { kind: cap.kind, json: cap.json, text: cap.text } : null });
  }
  if (msg?.type === "getDebug") {
    return Promise.resolve({
      log: DBG.slice(-120),
      capturedVideos: [...capturedByVideo.keys()],
      lastCaptureAgeMs: lastCapture ? Date.now() - lastCapture.at : null,
    });
  }
});
