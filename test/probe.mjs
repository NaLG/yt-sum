#!/usr/bin/env node
// Transcript extraction probe — validates the exact pathway the extension uses,
// runnable from plain Node (no deps, Node 18+). Usage:
//   node test/probe.mjs                      # standard suite: short / ~30min / ~2hr videos
//   node test/probe.mjs VIDEO_ID [...]       # probe specific videos
//   node test/probe.mjs --burst N            # N sequential extractions to observe rate limiting
//
// Pathway under test (primary path of the extension):
//   1. GET  https://www.youtube.com/watch?v=ID          -> bootstrap (api key, client version, transcript params)
//   2. POST https://www.youtube.com/youtubei/v1/get_transcript  -> full transcript in ONE response
// Also probes the legacy timedtext fallback to measure how often it is PoToken-gated (empty 200).

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0";

const HEADERS = {
  "user-agent": UA,
  "accept-language": "en-US,en;q=0.9",
};

async function fetchText(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function rx(html, re, group = 1) {
  const m = html.match(re);
  return m ? m[group] : null;
}

// Values captured out of inline JSON carry JSON string escapes (= etc.) — unescape them.
function jsonUnescape(s) {
  if (s == null) return s;
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

// Extract a balanced JSON object starting at the first { after `anchor`.
function extractJsonObject(html, anchor) {
  const idx = html.indexOf(anchor);
  if (idx === -1) return null;
  const start = html.indexOf("{", idx + anchor.length);
  if (start === -1) return null;
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) {
      esc = false;
    } else if (c === "\\") {
      esc = true;
    } else if (c === '"') {
      inStr = !inStr;
    } else if (!inStr) {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

// --- Step 1: bootstrap from watch page HTML -------------------------------

async function getBootstrap(videoId) {
  const t0 = performance.now();
  const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}&hl=en`);
  const ms = performance.now() - t0;

  const apiKey = rx(html, /"INNERTUBE_API_KEY":"([^"]+)"/);
  const clientVersion = rx(html, /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  const context = extractJsonObject(html, '"INNERTUBE_CONTEXT":');
  const params = jsonUnescape(rx(html, /"getTranscriptEndpoint":\s*\{"params":"([^"]+)"/));
  const title = (rx(html, /<title>([^<]*)<\/title>/) || "").replace(" - YouTube", "");
  const lengthSeconds = Number(rx(html, /"lengthSeconds":"(\d+)"/) || 0);

  let captionTracks = null;
  const ctRaw = rx(html, /"captionTracks":(\[.+?\}\])/s);
  if (ctRaw) {
    try {
      captionTracks = JSON.parse(ctRaw);
    } catch {
      captionTracks = null;
    }
  }

  return { videoId, html, apiKey, clientVersion, context, params, title, lengthSeconds, captionTracks, fetchMs: ms };
}

// --- Step 2: InnerTube get_transcript (primary path) ----------------------

function collectSegments(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectSegments(item, out);
  } else if (node && typeof node === "object") {
    if (node.transcriptSegmentRenderer) {
      const seg = node.transcriptSegmentRenderer;
      const text = (seg.snippet?.runs || []).map((r) => r.text).join("");
      out.push({ startMs: Number(seg.startMs || 0), endMs: Number(seg.endMs || 0), text });
    } else {
      for (const v of Object.values(node)) collectSegments(v, out);
    }
  }
  return out;
}

async function getTranscript(boot) {
  if (!boot.params) throw new Error("no getTranscriptEndpoint params in watch page (video may have no transcript)");
  const t0 = performance.now();
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false&key=${boot.apiKey}`,
    {
      method: "POST",
      headers: {
        ...HEADERS,
        "content-type": "application/json",
        origin: "https://www.youtube.com",
        referer: `https://www.youtube.com/watch?v=${boot.videoId}`,
        "x-youtube-client-name": "1",
        "x-youtube-client-version": boot.clientVersion,
      },
      body: JSON.stringify({
        // Send the page's own INNERTUBE_CONTEXT verbatim (includes visitorData) —
        // minimal hand-built contexts trip "Precondition check failed" validation.
        context: boot.context ?? {
          client: { clientName: "WEB", clientVersion: boot.clientVersion, hl: "en", gl: "US" },
        },
        params: boot.params,
      }),
    }
  );
  const status = res.status;
  const body = await res.text();
  const ms = performance.now() - t0;
  if (status !== 200) return { ok: false, status, ms, error: body.slice(0, 200) };
  const segments = collectSegments(JSON.parse(body));
  const chars = segments.reduce((n, s) => n + s.text.length, 0);
  return { ok: segments.length > 0, status, ms, bytes: body.length, segments: segments.length, chars, sample: segments };
}

// --- Legacy fallback: timedtext via captionTracks baseUrl -----------------

async function getTimedtext(boot) {
  if (!boot.captionTracks?.length) return { ok: false, note: "no captionTracks in page" };
  // prefer English or first track
  const track =
    boot.captionTracks.find((t) => (t.languageCode || "").startsWith("en")) || boot.captionTracks[0];
  const potGated = /[?&]exp=xpe/.test(track.baseUrl) ? "exp=xpe present" : "no exp=xpe";
  const t0 = performance.now();
  const res = await fetch(track.baseUrl.replace(/\\u0026/g, "&") + "&fmt=json3", { headers: HEADERS });
  const body = await res.text();
  const ms = performance.now() - t0;
  if (res.status !== 200) return { ok: false, status: res.status, ms, potGated };
  if (body.length === 0) return { ok: false, status: 200, empty: true, ms, potGated };
  let events = 0,
    chars = 0;
  try {
    const data = JSON.parse(body);
    for (const ev of data.events || []) {
      if (!ev.segs) continue;
      events++;
      chars += ev.segs.map((s) => s.utf8 || "").join("").length;
    }
  } catch {
    return { ok: false, status: 200, ms, potGated, note: "unparseable body" };
  }
  return { ok: chars > 0, status: 200, ms, bytes: body.length, events, chars, potGated };
}

// --- Search helper: find long videos to test with --------------------------

function parseDuration(str) {
  // "1:23:45" or "23:45" -> seconds
  const parts = str.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function collectVideoRenderers(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectVideoRenderers(item, out);
  } else if (node && typeof node === "object") {
    if (node.videoRenderer?.videoId && node.videoRenderer?.lengthText?.simpleText) {
      out.push({
        videoId: node.videoRenderer.videoId,
        seconds: parseDuration(node.videoRenderer.lengthText.simpleText),
        title: (node.videoRenderer.title?.runs || []).map((r) => r.text).join(""),
      });
    } else {
      for (const v of Object.values(node)) collectVideoRenderers(v, out);
    }
  }
  return out;
}

async function searchVideos(query) {
  const html = await fetchText(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`
  );
  const raw = rx(html, /var ytInitialData = (\{.+?\});<\/script>/s);
  if (!raw) throw new Error("could not parse ytInitialData from search results");
  return collectVideoRenderers(JSON.parse(raw));
}

// --- Reporting -------------------------------------------------------------

function fmtDur(seconds) {
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s).padStart(2, "0")}s`;
}

async function probeVideo(videoId, label = "") {
  const totalStart = performance.now();
  let boot;
  try {
    boot = await getBootstrap(videoId);
  } catch (e) {
    console.log(`\n[${label || videoId}] BOOTSTRAP FAILED: ${e.message}`);
    return { videoId, ok: false, stage: "bootstrap", error: e.message };
  }
  let tr;
  try {
    tr = await getTranscript(boot);
  } catch (e) {
    tr = { ok: false, error: e.message };
  }
  const tt = await getTimedtext(boot).catch((e) => ({ ok: false, error: e.message }));
  const totalMs = performance.now() - totalStart;

  console.log(`\n[${label || videoId}] ${boot.title}  (${fmtDur(boot.lengthSeconds)})`);
  console.log(
    `  bootstrap: ${boot.fetchMs.toFixed(0)}ms  (apiKey ${boot.apiKey ? "✓" : "✗"}, params ${
      boot.params ? "✓" : "✗"
    }, captionTracks ${boot.captionTracks ? boot.captionTracks.length : 0})`
  );
  if (tr.ok) {
    console.log(
      `  get_transcript: ${tr.ms.toFixed(0)}ms  -> ${tr.segments} segments, ${tr.chars.toLocaleString()} chars (${(
        tr.bytes / 1024
      ).toFixed(0)} KB) in ONE response`
    );
  } else {
    console.log(`  get_transcript: FAILED (${tr.status || ""} ${tr.error || "no segments"})`);
  }
  if (tt.ok) {
    console.log(
      `  timedtext fallback: ${tt.ms.toFixed(0)}ms -> ${tt.chars.toLocaleString()} chars [${tt.potGated}]`
    );
  } else {
    console.log(
      `  timedtext fallback: ${tt.empty ? "EMPTY 200 (PoToken-gated)" : "unavailable"} [${tt.potGated || tt.note || tt.error || ""}]`
    );
  }
  console.log(`  end-to-end: ${totalMs.toFixed(0)}ms`);
  return { videoId, ok: !!tr.ok, totalMs, chars: tr.chars, seconds: boot.lengthSeconds, timedtextOk: !!tt.ok };
}

// --- Main ------------------------------------------------------------------

const args = process.argv.slice(2);

if (args[0] === "--burst") {
  const n = Number(args[1] || 8);
  console.log(`Burst test: ${n} sequential full extractions (watch page + get_transcript each)...`);
  const found = await searchVideos("podcast interview");
  const targets = found.filter((v) => v.seconds > 600).slice(0, n);
  const results = [];
  for (const [i, v] of targets.entries()) {
    const r = await probeVideo(v.videoId, `burst ${i + 1}/${targets.length}`);
    results.push(r);
  }
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\nBurst result: ${okCount}/${results.length} succeeded, no throttling observed = ${okCount === results.length}`);
} else if (args.length > 0) {
  for (const id of args) await probeVideo(id);
} else {
  // Standard suite: a short video plus discovered ~30min and ~2h+ videos.
  console.log("Discovering test videos via YouTube search...");
  const found = await searchVideos("lex fridman podcast");
  const mid = found.find((v) => v.seconds >= 1500 && v.seconds <= 3600);
  const long = found.find((v) => v.seconds >= 7200);
  await probeVideo("dQw4w9WgXcQ", "short");
  if (mid) await probeVideo(mid.videoId, "~30min");
  else console.log("(no ~30min video found in search results)");
  if (long) await probeVideo(long.videoId, "2h+");
  else console.log("(no 2h+ video found in search results)");
}
