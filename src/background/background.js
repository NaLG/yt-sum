const GT_URLS = ["*://*.youtube.com/youtubei/v1/get_transcript*"];
const TT_URLS = ["*://*.youtube.com/api/timedtext*"];
const capturedByVideo = new Map();
let lastCapture = null;

const START = Date.now();
const DBG = [];
function dbg(m, extra) {
  const e = { dt: Date.now() - START, m, ...(extra || {}) };
  DBG.push(e);
  if (DBG.length > 300) DBG.shift();
  try { console.log("[yap-sum:bg]", m, extra || ""); } catch {}
}
dbg("background loaded; webRequest available", { has: typeof browser.webRequest?.filterResponseData === "function" });

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

function collectBody(requestId, onText, onErr) {
  const filter = browser.webRequest.filterResponseData(requestId);
  const chunks = [];
  filter.ondata = (event) => {
    chunks.push(new Uint8Array(event.data));
    filter.write(event.data);
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

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const videoId = (details.url.match(/[?&]v=([\w-]{11})/) || [])[1] || null;
    let q = null;
    try { q = new URL(details.url).searchParams; } catch {}
    dbg("timedtext request seen", { videoId, pot: !!q?.has("pot"), fmt: q?.get("fmt") ?? null, kind: q?.get("kind") ?? null, lang: q?.get("lang") ?? null });
    collectBody(
      details.requestId,
      (text) => {
        dbg("timedtext response", { bytes: text.length, videoId, first60: text.slice(0, 60) });
        if (text.length > 50 && videoId) {
          capturedByVideo.set(videoId, { at: Date.now(), kind: "timedtext", text });
          pruneCaptures();
        }
      },
      (e) => dbg("timedtext capture error", { err: String(e) })
    );
    return {};
  },
  { urls: TT_URLS },
  ["blocking"]
);

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
          pruneCaptures();
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
  const byId = videoId && capturedByVideo.get(videoId);
  if (byId) return byId;
  if (lastCapture && Date.now() - lastCapture.at < 20000) return lastCapture;
  return null;
}

const CAPTURE_MAX = 20;
function pruneCaptures() {
  const cutoff = Date.now() - 600000;
  for (const [k, v] of capturedByVideo) if (v.at < cutoff) capturedByVideo.delete(k);
  while (capturedByVideo.size > CAPTURE_MAX)
    capturedByVideo.delete(capturedByVideo.keys().next().value);
}

const DEFAULTS = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  label: "",
  apiKey: "",
  buttonStyle: "text",
  anthropicVersion: "2023-06-01",
  systemPrompt:
    "You summarize YouTube video transcripts. Produce a tight, skimmable summary: " +
    "a one-sentence TL;DR, then 5-10 bullet points of the key claims, facts, and takeaways " +
    "in the order they appear. Prefer concrete detail over generalities. Omit sponsor reads, " +
    "subscribe requests, and filler. If the video is a tutorial, capture the steps.",
  maxTokens: 4000,
  maxTranscriptChars: 320000,
  extraModels: [],
  chunkChars: 100000,
  maxChunks: 10,
};

async function getConfig(modelId) {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  const base = { ...DEFAULTS, ...stored };
  if (!modelId) return base;
  const entry = (base.extraModels || []).find((m) => m && m.id === modelId);
  if (!entry) throw new Error("The selected model is no longer in settings. Pick another from the panel's model menu.");
  const cfg = { ...base };
  for (const f of ["provider", "baseUrl", "model", "apiKey"]) if (entry[f]) cfg[f] = entry[f];
  if (cfg.baseUrl !== base.baseUrl && !entry.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl))
    throw new Error(`The "${entry.label || entry.model}" model uses a different endpoint but has no API key of its own. Add one in settings.`);
  return cfg;
}

function trimTranscript(text, maxChars) {
  if (text.length <= maxChars) return text;
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

function buildRequest(cfg, system, messages) {
  if (cfg.provider === "anthropic") {
    return {
      url: `${cfg.baseUrl.replace(/\/$/, "")}/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": cfg.anthropicVersion,
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
      finish: finishAnthropicSSE,
    };
  }
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
    finish: finishOpenAISSE,
  };
}

function parseOpenAISSE(json) {
  return json?.choices?.[0]?.delta?.content || "";
}
function parseAnthropicSSE(json) {
  if (json?.type === "content_block_delta" && json.delta?.type === "text_delta") return json.delta.text || "";
  return "";
}

function finishOpenAISSE(json) {
  return json?.choices?.[0]?.finish_reason || null;
}
function finishAnthropicSSE(json) {
  return json?.type === "message_delta" ? json.delta?.stop_reason || null : null;
}

function finishNotice(finish, cfg) {
  if (!finish || finish === "stop" || finish === "end_turn" || finish === "stop_sequence") return null;
  if (finish === "length" || finish === "max_tokens")
    return `Output was cut off: the model hit the max-tokens limit (${cfg.maxTokens}). Raise "Max output tokens" in settings; reasoning models (e.g. Gemini Flash) also spend this budget on hidden thinking before writing.`;
  if (finish === "content_filter")
    return "The provider stopped the output early (content filter; for transcripts this is often a recitation false-positive). Re-running sometimes succeeds.";
  return `Output ended abnormally (finish reason: ${finish}).`;
}

const STREAM_STALL_MS = 120000;

async function callLLM(cfg, system, messages, onDelta) {
  const req = buildRequest(cfg, system, messages);
  const t0 = Date.now();
  dbg("llm call", {
    host: (req.url.match(/^https?:\/\/([^/]+)/) || [])[1],
    model: cfg.model,
    provider: cfg.provider,
    promptChars: system.length + messages.reduce((n, m) => n + (m.content?.length || 0), 0),
  });
  const ctrl = new AbortController();
  let watchdog = setTimeout(() => ctrl.abort(), STREAM_STALL_MS);
  const rearm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ctrl.abort(), STREAM_STALL_MS); };
  let res;
  try {
    res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: ctrl.signal });
  } catch (e) {
    clearTimeout(watchdog);
    if (ctrl.signal.aborted) throw new Error(`No response from the LLM endpoint after ${STREAM_STALL_MS / 1000}s; gave up.`);
    throw new Error(`Network error reaching the LLM endpoint: ${e.message}`);
  }
  if (!res.ok) {
    clearTimeout(watchdog);
    const body = await res.text().catch(() => "");
    dbg("llm http error", { status: res.status, ms: Date.now() - t0, first120: body.slice(0, 120) });
    throw new Error(`LLM endpoint returned ${res.status}. ${body.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let finish = null;
  let events = 0;
  let firstDataMs = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      rearm();
      if (firstDataMs === null) {
        firstDataMs = Date.now() - t0;
        dbg("llm first data", { ms: firstDataMs });
      }
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        if (json?.error) throw new Error(json.error.message || JSON.stringify(json.error).slice(0, 300));
        events++;
        finish = req.finish(json) || finish;
        const delta = req.parse(json);
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      }
    }
  } catch (e) {
    dbg("llm stream error", { ms: Date.now() - t0, events, chars: full.length, aborted: ctrl.signal.aborted, err: String(e) });
    if (ctrl.signal.aborted)
      throw new Error(`The stream stalled: no data from the LLM endpoint for ${STREAM_STALL_MS / 1000}s. Try again.`);
    throw new Error(`Stream interrupted: ${e.message}`);
  } finally {
    clearTimeout(watchdog);
  }
  dbg("llm done", { ms: Date.now() - t0, firstDataMs, events, chars: full.length, finish });
  return { text: full, finish };
}

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
  if (cfg.chunkChars > 0 && transcript.length > cfg.chunkChars * 1.2) {
    const capped = trimTranscript(transcript, cfg.chunkChars * cfg.maxChunks);
    const parts = splitTranscript(capped, cfg.chunkChars, cfg.maxChunks);
    const notes = [];
    let truncatedParts = 0;
    for (let i = 0; i < parts.length; i++) {
      port.postMessage({ type: "stage", text: `Long transcript, summarizing part ${i + 1}/${parts.length}…` });
      const part = await callLLM(cfg, PART_SYSTEM, [
        { role: "user", content: `Video title: ${title}\n\nTranscript PART ${i + 1} of ${parts.length} (timestamps in brackets):\n\n${parts[i]}` },
      ]);
      if (part.finish === "length" || part.finish === "max_tokens") truncatedParts++;
      notes.push(part.text);
    }
    port.postMessage({ type: "stage", text: `Synthesizing summary from ${parts.length} parts…` });
    const synthesis =
      `Video title: ${title}\n\nThe video's transcript was processed in ${parts.length} sequential parts. ` +
      `Notes for each part, in order:\n\n` +
      notes.map((n, i) => `--- Part ${i + 1} notes ---\n${n}`).join("\n\n") +
      `\n\nWrite the final summary of the WHOLE video from these notes.`;
    const res = await callLLM(cfg, cfg.systemPrompt, [{ role: "user", content: synthesis }], (d) =>
      port.postMessage({ type: "chunk", text: d })
    );
    if (truncatedParts)
      port.postMessage({ type: "notice", text: `${truncatedParts} of ${parts.length} note-taking calls hit the max-tokens limit; some detail may be missing.` });
    const notice = finishNotice(res.finish, cfg);
    if (notice) port.postMessage({ type: "notice", text: notice });
    port.postMessage({ type: "done", text: res.text });
    return;
  }

  const userPrompt = buildUserPrompt(title, trimTranscript(transcript, cfg.maxTranscriptChars));
  const res = await callLLM(cfg, cfg.systemPrompt, [{ role: "user", content: userPrompt }], (d) =>
    port.postMessage({ type: "chunk", text: d })
  );
  const notice = finishNotice(res.finish, cfg);
  if (notice) port.postMessage({ type: "notice", text: notice });
  port.postMessage({ type: "done", text: res.text });
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
  const res = await callLLM(cfg, FOLLOWUP_SYSTEM, messages, (d) => port.postMessage({ type: "chunk", text: d }));
  const notice = finishNotice(res.finish, cfg);
  if (notice) port.postMessage({ type: "notice", text: notice });
  port.postMessage({ type: "done", text: res.text });
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "summarize") return;
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "summarize" && msg.type !== "followup") return;
    let cfg;
    try {
      cfg = await getConfig(msg.modelId || null);
    } catch (e) {
      port.postMessage({ type: "error", error: e.message });
      return;
    }
    if (!cfg.apiKey) {
      port.postMessage({
        type: "error",
        error: "No API key configured. Open the Return YouTube Summary settings (toolbar icon, then Settings) and add your provider + API key. The settings page links to where to get one; Google Gemini has a free tier.",
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

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "getDefaults") return Promise.resolve(DEFAULTS);
  if (msg?.type === "getModels") {
    return getConfig().then((cfg) => ({
      defaultModel: cfg.model,
      defaultLabel: cfg.label || cfg.model,
      extra: (cfg.extraModels || []).filter((m) => m && m.id && m.model)
        .map((m) => ({ id: m.id, label: m.label || m.model, model: m.model })),
    }));
  }
  if (msg?.type === "armCapture") {
    pruneCaptures();
    return Promise.resolve({ armed: true });
  }
  if (msg?.type === "getCaptured") {
    const cap = getCapturedFor(msg.videoId);
    dbg("getCaptured", { videoId: msg.videoId, hit: !!cap, kind: cap?.kind });
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
