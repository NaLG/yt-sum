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
  function extractBalanced(text, anchor, open, close) {
    const idx = text.indexOf(anchor);
    if (idx === -1) return null;
    const start = text.indexOf(open, idx + anchor.length);
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = !inStr;
      else if (!inStr) {
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
      }
    }
    return null;
  }
  const extractJsonObject = (text, anchor) => extractBalanced(text, anchor, "{", "}");
  const extractJsonArray = (text, anchor) => extractBalanced(text, anchor, "[", "]");
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

  // The transcript control varies by A/B variant and viewport: <button>,
  // yt-button-shape, [role=button], sometimes an <a>. aria-label match first
  // (most precise), then short visible text ("Transcript" / "Show transcript") —
  // the length guard keeps comment links etc. from matching.
  const BUTTONISH = "button, tp-yt-paper-button, yt-button-shape, ytd-button-renderer, [role=button], a";
  function findTranscriptButton() {
    let b = document.querySelector('button[aria-label*="transcript" i], [role=button][aria-label*="transcript" i]');
    if (!b) {
      const all = Array.from(document.querySelectorAll(BUTTONISH));
      b = all.find((x) => /transcript/i.test(x.getAttribute("aria-label") || ""));
      if (!b) {
        b = all.find((x) => {
          const t = (x.textContent || "").trim();
          return t.length <= 40 && /transcript/i.test(t);
        });
      }
    }
    return b;
  }

  const TS_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;

  // Generic, variant-proof transcript scrape. YouTube ships several different
  // transcript-panel markups across A/B experiments, so instead of matching
  // specific tag/class names we key on STRUCTURE: a transcript row is any
  // element that directly contains a timestamp-only child, followed by text.
  // We then keep the largest group of such rows sharing one parent (the
  // transcript list). Reads whatever is already rendered — no panel toggling.
  // Find the transcript engagement panel specifically, so we never mistake
  // related-video durations or chapter markers for transcript rows.
  // Several transcript-ish containers can coexist (e.g. an empty
  // "PAmodern_transcript_view" stub next to the populated panel), so return
  // ALL candidates — detectTranscript picks the one that actually has rows.
  function transcriptPanelCandidates() {
    const seen = new Set();
    const out = [];
    const add = (el) => { if (el && !seen.has(el)) { seen.add(el); out.push(el); } };
    for (const el of document.querySelectorAll(
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript" i], [target-id*="transcript" i]'
    )) add(el);
    for (const panel of document.querySelectorAll("ytd-engagement-panel-section-list-renderer")) {
      const title = panel.querySelector('#title-text, [id*="title" i], [class*="title" i], h1, h2, yt-formatted-string');
      if (title && /^\s*transcript\s*$/i.test((title.textContent || "").trim())) add(panel);
    }
    for (const el of document.querySelectorAll("ytd-transcript-renderer, ytd-transcript-segment-list-renderer")) add(el);
    for (const el of document.querySelectorAll(
      '[class*="transcript" i][class*="content" i], [class*="transcript" i][class*="body" i]'
    )) add(el);
    return out;
  }

  // Read whatever transcript rows are currently rendered inside the transcript
  // panel. Variant-proof: keys on structure (timestamp + text rows) rather than
  // tag/class names. Returns { segs, list, panel } or null. Returns null if the
  // transcript panel isn't present/open — we do NOT scrape stray timestamps
  // elsewhere on the page.
  function detectTranscript() {
    let best = null;
    for (const panel of transcriptPanelCandidates()) {
      const d = detectTranscriptIn(panel);
      if (d && (!best || d.segs.length > best.segs.length)) best = d;
    }
    return best;
  }

  function detectTranscriptIn(panel) {
    const tsEls = [];
    for (const el of panel.querySelectorAll("*")) {
      if (el.children.length === 0 && TS_RE.test((el.textContent || "").trim())) tsEls.push(el);
    }
    if (tsEls.length < 3) return null;

    // The list is the container with the most timestamp-bearing ROW children.
    // Rows sit in their own wrappers, so grouping by immediate parent fails —
    // walk up and credit each ancestor for the distinct child leading to a ts.
    const childRows = new Map();
    for (const ts of tsEls) {
      let node = ts, depth = 0;
      while (node.parentElement && depth++ < 15) {
        const parent = node.parentElement;
        let set = childRows.get(parent);
        if (!set) { set = new Set(); childRows.set(parent, set); }
        set.add(node);
        node = parent;
      }
    }
    let list = null, max = 0;
    for (const [el, set] of childRows) if (set.size > max) { max = set.size; list = el; }
    if (max < 3) return null;

    const segs = [];
    for (const row of childRows.get(list)) {
      const full = (row.textContent || "").replace(/\s+/g, " ").trim();
      const m = full.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
      if (!m) continue;
      const ts = m[1];
      let text = full.slice(full.indexOf(ts) + ts.length).trim();
      if (!text) text = full.slice(0, m.index).trim();
      if (text && text.length <= 600) segs.push({ startMs: stampToMs(ts), text });
    }
    if (segs.length < 3) return null;
    return { segs, list, panel };
  }

  function scrapeSegments() {
    const d = detectTranscript();
    return d ? d.segs : [];
  }

  NS.findTranscriptButton = findTranscriptButton; // used by the debug bundle

  // Debug helper: report whether/how the transcript panel was located.
  NS.transcriptPanelInfo = function transcriptPanelInfo() {
    const candidates = transcriptPanelCandidates();
    if (!candidates.length) return null;
    const d = detectTranscript();
    const p = (d && candidates.find((c) => c.contains(d.list))) || candidates[0];
    return {
      tag: p.tagName.toLowerCase(),
      targetId: p.getAttribute("target-id"),
      cls: String(p.className).slice(0, 60),
      rows: d ? d.segs.length : 0,
      candidates: candidates.length,
    };
  };

  function findScroller(el) {
    let node = el;
    for (let i = 0; i < 10 && node; i++) {
      const s = getComputedStyle(node);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 20) return node;
      node = node.parentElement;
    }
    return null;
  }

  // Sync: read only the currently-rendered rows (fast; may be partial if the
  // panel is virtualized).
  NS.scrapeVisibleTranscript = function scrapeVisibleTranscript() {
    const segs = scrapeSegments();
    return segs.length ? segs : null;
  };

  // Async: get the FULL transcript from a (possibly virtualized) panel by
  // scrolling through it and accumulating unique rows, then restoring the
  // scroll position. Used as the fallback when the network intercept isn't
  // available.
  NS.scrapeTranscriptFull = async function scrapeTranscriptFull() {
    const d = detectTranscript();
    if (!d) return null;
    const collected = new Map();
    const add = (arr) => { for (const s of arr) if (!collected.has(s.startMs)) collected.set(s.startMs, s.text); };
    add(d.segs);

    const scroller = findScroller(d.list);
    if (scroller) {
      const saved = scroller.scrollTop;
      scroller.scrollTop = 0;
      await sleep(100);
      let noNew = 0;
      for (let i = 0; i < 400 && noNew < 3; i++) {
        const before = collected.size;
        add(scrapeSegments());
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
        if (collected.size === before) { if (atBottom) noNew++; } else noNew = 0;
        scroller.scrollTop += Math.max(scroller.clientHeight * 0.8, 150);
        await sleep(60);
      }
      scroller.scrollTop = saved; // restore to minimize visual disruption
    }

    const out = [...collected.entries()].map(([startMs, text]) => ({ startMs, text })).sort((a, b) => a.startMs - b.startMs);
    return out.length ? out : null;
  };

  function readPanelSegments() {
    return scrapeSegments();
  }

  // Trigger YouTube's own transcript panel (which makes the player fire its
  // attested get_transcript request). Used by the content-script intercept path
  // and by the DOM-scrape fallback. Returns true if a trigger was clicked or a
  // panel is already open.
  NS.openTranscriptPanel = async function openTranscriptPanel() {
    if (readPanelSegments().length) return true; // already open
    let btn = findTranscriptButton();
    if (!btn) {
      // The control usually lives in the EXPANDED description. Known #expand ids
      // first, then any button-ish "…more"/"Show more" (never "More options").
      const expand =
        document.querySelector("#description #expand, #expand, ytd-text-inline-expander #expand, tp-yt-paper-button#expand") ||
        Array.from(document.querySelectorAll("button, [role=button]")).find((el) => {
          const label = ((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).trim().slice(0, 60);
          return /show more|…more|\.\.\.more|^more$|expand/i.test(label) && !/options|less/i.test(label);
        });
      if (expand) expand.click();
      // The button can render a beat after expansion (SPA), so poll for it.
      for (let i = 0; i < 10 && !btn; i++) {
        await sleep(400);
        btn = findTranscriptButton();
      }
    }
    if (!btn) throw new Error("no Show transcript control found");
    btn.scrollIntoView();
    btn.click();
    return true;
  };

  // Close the transcript panel we opened (used to clean up after a last-resort
  // open, so we don't leave visual noise the user didn't ask for).
  NS.closeTranscriptPanel = function closeTranscriptPanel() {
    const btn = findTranscriptButton();
    if (btn) btn.click(); // toggles the panel closed
  };

  async function viaPanelScrape() {
    let segs = readPanelSegments();
    if (!segs.length) {
      await NS.openTranscriptPanel();
      // Wait for the panel to populate. YouTube renders the full transcript at
      // once (not virtualized), so once segments appear they're complete.
      for (let i = 0; i < 40 && !segs.length; i++) {
        await sleep(300);
        segs = readPanelSegments();
      }
      if (segs.length) { await sleep(300); segs = readPanelSegments(); } // settle tail
    }
    if (!segs.length) throw new Error("transcript panel did not populate");
    return { method: "panel", segments: segs };
  }

  // ---- method 2: InnerTube get_transcript (fast path, often gated) ----------

  function bootstrapFromText(text) {
    return {
      apiKey: rx(text, /"INNERTUBE_API_KEY":"([^"]+)"/),
      clientVersion: rx(text, /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/),
      context: extractJsonObject(text, '"INNERTUBE_CONTEXT":'),
      params: jsonUnescape(rx(text, /"getTranscriptEndpoint":\s*\{"params":"([^"]+)"/)),
      // Balanced parse — a lazy /\[.+?\}\]/ regex truncates when a track's
      // name uses runs (nested "}]"), as the mobile player response does.
      captionTracks: extractJsonArray(text, '"captionTracks":'),
    };
  }
  function pageText() {
    return Array.from(document.scripts, (s) => s.text || "").join("\n") + document.documentElement.innerHTML;
  }
  async function getBootstrap(videoId) {
    const domBoot = bootstrapFromText(pageText());
    if (domBoot.apiKey && domBoot.params) return domBoot;
    let fetched = null;
    try {
      const res = await fetch(`${location.origin}/watch?v=${videoId}`, { credentials: "include" });
      fetched = bootstrapFromText(await res.text());
    } catch { /* offline/refused — the DOM bootstrap is all we have */ }
    if (!fetched) return domBoot;
    // Per-field merge: the refetched page (m.youtube.com especially) can be a
    // JS shell MISSING fields the live DOM already has — never erase those.
    return {
      apiKey: fetched.apiKey || domBoot.apiKey,
      clientVersion: fetched.clientVersion || domBoot.clientVersion,
      context: fetched.context || domBoot.context,
      params: fetched.params || domBoot.params,
      captionTracks: fetched.captionTracks || domBoot.captionTracks,
    };
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

  // Parse a caption-track body (the player fetches these when CC turns on).
  // json3 ({events:[{tStartMs,segs:[{utf8}]}]}) or srv XML (<text start dur>).
  NS.parseTimedtextBody = function parseTimedtextBody(text) {
    if (!text || !text.trim()) return null;
    try {
      const events = JSON.parse(text).events || [];
      const segments = events
        .filter((e) => e.segs)
        .map((e) => ({ startMs: Number(e.tStartMs || 0), text: e.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " ") }))
        .filter((s) => s.text.trim());
      return segments.length ? segments : null;
    } catch { /* not JSON — try XML */ }
    try {
      const doc = new DOMParser().parseFromString(text, "text/xml");
      const segments = Array.from(doc.querySelectorAll("text"))
        .map((n) => ({ startMs: Math.round(parseFloat(n.getAttribute("start") || "0") * 1000), text: (n.textContent || "").trim() }))
        .filter((s) => s.text);
      return segments.length ? segments : null;
    } catch {
      return null;
    }
  };

  async function viaTimedtext(videoId) {
    const boot = await getBootstrap(videoId);
    const tracks = boot.captionTracks;
    if (!tracks?.length) throw new Error("no captionTracks");
    const track = tracks.find((t) => (t.languageCode || "").startsWith("en")) || tracks[0];
    const raw = jsonUnescape(track.baseUrl);
    const url = /^https?:/i.test(raw) ? raw : location.origin + raw; // mobile baseUrl is relative
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "fmt=json3", { credentials: "include" });
    const text = await res.text();
    if (!res.ok) throw new Error(`timedtext HTTP ${res.status}`);
    if (!text) throw new Error("timedtext EMPTY 200 (PoToken-gated)");
    const segments = NS.parseTimedtextBody(text);
    if (!segments) throw new Error("timedtext had no text events");
    return { method: "timedtext", segments };
  }

  // ---- public API -----------------------------------------------------------

  NS.currentVideoId = function () {
    return (
      new URLSearchParams(location.search).get("v") ||
      rx(location.pathname, /\/(?:shorts|live)\/([\w-]{11})/) ||
      null
    );
  };

  // Parse a captured get_transcript JSON response into segments (the network
  // intercept path). Returns null if it has no transcript.
  NS.parseGetTranscriptJson = function (json) {
    const segments = collectSegments(json);
    return segments.length ? segments : null;
  };

  // Format segments into the standard result shape (shared by all methods).
  NS.buildResult = function (videoId, method, segments, timings, errors) {
    const text = segments.map((s) => `[${msToStamp(s.startMs)}] ${s.text}`).join("\n");
    return { videoId, method, segments, text, chars: text.length, timings: timings || {}, errors: errors || [] };
  };

  // opts.order lets tests force a single method. Default order leads with the
  // proven-reliable panel scrape.
  NS.extractTranscript = async function extractTranscript(videoId, opts = {}) {
    videoId = videoId || NS.currentVideoId();
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
