// yap-sum transcript extractor — runs in the YouTube page context.
// No WebExtension APIs here: this file is loaded by the content script AND
// injected verbatim by the test harnesses, so shipped code == tested code.
//
// Extraction strategy, in order (see README "Why this design"):
//   1. DOM panel scrape — trigger YouTube's own "Show transcript" panel and read
//      the rendered segments. YouTube's app fetches the full transcript in one
//      internal call (carrying the PoToken/attestation it generates itself) and
//      renders every segment into the DOM. Proven to work even logged-out.
//   2. get_transcript reconstruction — fast, no UI, but its precondition often
//      fails outside a warmed/logged-in session; used as an opportunistic fast path.
//   3. timedtext (captionTracks + fmt=json3) — legacy; increasingly PoToken-gated
//      (empty 200). Last resort.
//
// Empirical note (test/*.mjs): standalone reconstruction of get_transcript
// returns 400 "failedPrecondition" even from the real page — YouTube gates it
// on an attestation only its own app produces. So we let the app do the fetch
// and scrape the result, rather than forging the request ourselves.

(() => {
  const NS = (globalThis.yapSum = globalThis.yapSum || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- small parsing helpers ----

  function rx(text, re, group = 1) {
    const m = text.match(re);
    return m ? m[group] : null;
  }
  function jsonUnescape(s) {
    if (s == null) return s;
    try { return JSON.parse(`"${s}"`); } catch { return s; }
  }
  function extractJsonObject(text, anchor) {
    const idx = text.indexOf(anchor);
    if (idx === -1) return null;
    const start = text.indexOf("{", idx + anchor.length);
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = !inStr;
      else if (!inStr) {
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
      }
    }
    return null;
  }
  function collectSegments(node, out = []) {
    if (Array.isArray(node)) for (const item of node) collectSegments(item, out);
    else if (node && typeof node === "object") {
      if (node.transcriptSegmentRenderer) {
        const seg = node.transcriptSegmentRenderer;
        const text = (seg.snippet?.runs || []).map((r) => r.text).join("");
        if (text.trim()) out.push({ startMs: Number(seg.startMs || 0), text });
      } else for (const v of Object.values(node)) collectSegments(v, out);
    }
    return out;
  }
  function msToStamp(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? [h, m, sec] : [m, sec]).map((n, i) => (i ? String(n).padStart(2, "0") : String(n))).join(":");
  }
  function stampToMs(str) {
    if (!str) return 0;
    const parts = str.trim().split(":").map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
  }

  // ---- method 1: DOM transcript-panel scrape (primary) ----------------------

  function findTranscriptButton() {
    let b = document.querySelector('button[aria-label*="transcript" i]');
    if (!b) {
      b = Array.from(document.querySelectorAll("button, tp-yt-paper-button, yt-button-shape")).find((x) =>
        /show transcript|transcript/i.test(x.getAttribute("aria-label") || x.textContent || "")
      );
    }
    return b;
  }

  function readPanelSegments() {
    const nodes = document.querySelectorAll("ytd-transcript-segment-renderer, .ytm-transcript-segment-renderer");
    const segs = [];
    for (const n of nodes) {
      const textEl = n.querySelector(".segment-text, yt-formatted-string.segment-text");
      const stampEl = n.querySelector(".segment-timestamp, .segment-start-offset");
      const text = (textEl?.textContent || "").trim();
      if (!text) continue;
      segs.push({ startMs: stampToMs(stampEl?.textContent), text });
    }
    return segs;
  }

  async function viaPanelScrape() {
    // Already open with content?
    let segs = readPanelSegments();
    if (segs.length) return { method: "panel", segments: segs };

    // Expand the description (the transcript button lives inside it on desktop).
    const expand = document.querySelector(
      "#description #expand, #expand, ytd-text-inline-expander #expand, tp-yt-paper-button#expand"
    );
    if (expand) { expand.click(); await sleep(600); }

    const btn = findTranscriptButton();
    if (!btn) throw new Error("no Show transcript button (video may lack a transcript)");
    btn.scrollIntoView();
    btn.click();

    // Wait for the panel to populate. YouTube renders the full transcript at
    // once (not virtualized), so once segments appear they're complete.
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      segs = readPanelSegments();
      if (segs.length) {
        // Let it finish painting the tail, then read once more.
        await sleep(300);
        segs = readPanelSegments();
        return { method: "panel", segments: segs };
      }
    }
    throw new Error("transcript panel did not populate");
  }

  // ---- method 2: InnerTube get_transcript (fast path, often gated) ----------

  function bootstrapFromText(text) {
    let captionTracks = null;
    const ctRaw = rx(text, /"captionTracks":(\[.+?\}\])/s);
    if (ctRaw) { try { captionTracks = JSON.parse(ctRaw); } catch { captionTracks = null; } }
    return {
      apiKey: rx(text, /"INNERTUBE_API_KEY":"([^"]+)"/),
      clientVersion: rx(text, /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/),
      context: extractJsonObject(text, '"INNERTUBE_CONTEXT":'),
      params: jsonUnescape(rx(text, /"getTranscriptEndpoint":\s*\{"params":"([^"]+)"/)),
      captionTracks,
    };
  }
  function pageText() {
    return Array.from(document.scripts, (s) => s.text || "").join("\n") + document.documentElement.innerHTML;
  }
  async function getBootstrap(videoId) {
    let boot = bootstrapFromText(pageText());
    if (boot.apiKey && boot.params) return boot;
    const res = await fetch(`${location.origin}/watch?v=${videoId}`, { credentials: "include" });
    return bootstrapFromText(await res.text());
  }
  async function viaGetTranscript(videoId) {
    const boot = await getBootstrap(videoId);
    if (!boot.params) throw new Error("no transcript params");
    const res = await fetch(
      `${location.origin}/youtubei/v1/get_transcript?prettyPrint=false${boot.apiKey ? `&key=${boot.apiKey}` : ""}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          context: boot.context ?? { client: { clientName: "WEB", clientVersion: boot.clientVersion, hl: "en" } },
          params: boot.params,
        }),
      }
    );
    if (!res.ok) throw new Error(`get_transcript HTTP ${res.status}`);
    const segments = collectSegments(await res.json());
    if (!segments.length) throw new Error("get_transcript returned no segments");
    return { method: "get_transcript", segments };
  }

  // ---- method 3: legacy timedtext -------------------------------------------

  async function viaTimedtext(videoId) {
    const boot = await getBootstrap(videoId);
    const tracks = boot.captionTracks;
    if (!tracks?.length) throw new Error("no captionTracks");
    const track = tracks.find((t) => (t.languageCode || "").startsWith("en")) || tracks[0];
    const res = await fetch(jsonUnescape(track.baseUrl) + "&fmt=json3", { credentials: "include" });
    const text = await res.text();
    if (!res.ok) throw new Error(`timedtext HTTP ${res.status}`);
    if (!text) throw new Error("timedtext EMPTY 200 (PoToken-gated)");
    const segments = (JSON.parse(text).events || [])
      .filter((e) => e.segs)
      .map((e) => ({ startMs: Number(e.tStartMs || 0), text: e.segs.map((s) => s.utf8 || "").join("") }))
      .filter((s) => s.text.trim());
    if (!segments.length) throw new Error("timedtext had no text events");
    return { method: "timedtext", segments };
  }

  // ---- public API -----------------------------------------------------------

  // opts.order lets tests force a single method. Default order leads with the
  // proven-reliable panel scrape.
  NS.extractTranscript = async function extractTranscript(videoId, opts = {}) {
    videoId =
      videoId ||
      new URLSearchParams(location.search).get("v") ||
      rx(location.pathname, /\/(?:shorts|live)\/([\w-]{11})/);
    if (!videoId) throw new Error("could not determine video id");

    const methods = {
      panel: () => viaPanelScrape(),
      get_transcript: () => viaGetTranscript(videoId),
      timedtext: () => viaTimedtext(videoId),
    };
    const order = opts.order || ["panel", "get_transcript", "timedtext"];

    const errors = [];
    let result = null, extractMs = 0;
    for (const name of order) {
      const t = performance.now();
      try {
        result = await methods[name]();
        extractMs = Math.round(performance.now() - t);
        break;
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
      }
    }
    if (!result) {
      const err = new Error(`all extraction methods failed: ${errors.join(" | ")}`);
      err.errors = errors;
      throw err;
    }

    const text = result.segments.map((s) => `[${msToStamp(s.startMs)}] ${s.text}`).join("\n");
    return {
      videoId,
      method: result.method,
      segments: result.segments,
      text,
      chars: text.length,
      timings: { extractMs },
      errors,
    };
  };
})();
