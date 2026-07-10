// yap-sum content orchestrator — runs on youtube.com/m.youtube.com.
// Responsibilities: detect watch pages, inject the Summarize button, and on
// click run extraction -> LLM -> render. Also a self-test hook for the
// automated test loop (web-ext run) that reports extraction results to console.

(() => {
  const NS = globalThis.yapSum;
  const LOG = "[yap-sum]";

  function currentVideoId() {
    const v = new URLSearchParams(location.search).get("v");
    if (v) return v;
    const m = location.pathname.match(/\/(?:shorts|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  function isWatchPage() {
    return !!currentVideoId();
  }

  // ---- self-test hook (used by test/webext-validate.mjs) --------------------
  // Loading a watch URL with #yapsum-selftest makes the content script run the
  // extractor immediately and print a tagged, machine-readable line to the
  // page console — which `web-ext run` streams to stdout. This is our
  // non-automated (non-WebDriver) validation of the extraction pathway.
  async function runSelfTest() {
    const started = Date.now();
    try {
      const r = await NS.extractTranscript();
      console.log(
        "YAPSUM_SELFTEST " +
          JSON.stringify({
            ok: true,
            videoId: r.videoId,
            method: r.method,
            segments: r.segments.length,
            chars: r.chars,
            timings: r.timings,
            fallbackErrors: r.errors,
            wallMs: Date.now() - started,
            first: r.segments[0]?.text?.slice(0, 60),
          })
      );
    } catch (e) {
      console.log(
        "YAPSUM_SELFTEST " +
          JSON.stringify({ ok: false, error: String(e), errors: e.errors, wallMs: Date.now() - started })
      );
    }
  }

  // ---- UI: inject the Summarize button --------------------------------------

  function buttonHost() {
    // Desktop: the actions row next to like/share. Prefer the one scoped under
    // #actions (the real watch-metadata row); the bare selector also matches
    // hidden/renderer-internal copies. Mobile: the slim action bar.
    return (
      document.querySelector("ytd-watch-metadata #actions #top-level-buttons-computed") ||
      document.querySelector("#actions #top-level-buttons-computed") ||
      document.querySelector("#actions-inner #top-level-buttons-computed") ||
      document.querySelector("ytm-slim-video-action-bar-renderer") ||
      document.querySelector("#actions-inner") ||
      null
    );
  }

  function ensureButton() {
    if (!isWatchPage()) return;
    // If our button is still attached to a live host, nothing to do.
    const existing = document.getElementById("yapsum-btn");
    if (existing && existing.isConnected && existing.parentElement) return;
    const host = buttonHost();
    if (!host) return;
    if (host.querySelector("#yapsum-btn")) return;
    const btn = document.createElement("button");
    btn.id = "yapsum-btn";
    btn.className = "yapsum-btn";
    btn.textContent = "Summarize";
    btn.title = "Return YouTube Summary: summarize this video";
    btn.addEventListener("click", onSummarizeClick);
    host.prepend(btn);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Per-attempt step log for diagnostics.
  let flow = [];
  function clog(m, x) {
    flow.push({ t: Date.now(), m, ...(x || {}) });
    try { console.log("[yap-sum]", m, x || ""); } catch {}
  }

  // Primary extraction: let YouTube's player fetch the transcript and capture
  // its JSON response at the network layer (background webRequest filter), which
  // is robust to UI variants. Falls back to the extractor's DOM/network methods.
  const t0 = () => performance.now();
  function result(videoId, method, segs, started) {
    document.documentElement.dataset.yapsumMethod = method;
    return NS.buildResult(videoId, method, segs, { ms: Math.round(performance.now() - started) }, []);
  }
  const captureFor = async (videoId) =>
    (await browser.runtime.sendMessage({ type: "getCaptured", videoId }))?.capture;
  // A capture is either the classic panel's get_transcript JSON or the player's
  // own caption-track fetch (timedtext) — parse whichever we got.
  const parseCapture = (cap) =>
    !cap ? null
    : cap.kind === "timedtext" ? NS.parseTimedtextBody(cap.text)
    : NS.parseGetTranscriptJson(cap.json);
  const methodOf = (cap) => (cap.kind === "timedtext" ? "captions-intercept" : "intercept");

  async function getTranscript() {
    const videoId = NS.currentVideoId();
    const started = t0();
    flow = [];
    clog("start", { videoId, url: location.href });
    await browser.runtime.sendMessage({ type: "armCapture" }).catch(() => {});

    // 1. Already captured passively (the player fetched it — user opened the
    //    transcript or had captions on earlier, or a prior visit). No UI.
    let cap = await captureFor(videoId).catch(() => null);
    clog("passive capture?", { hit: !!cap, kind: cap?.kind });
    if (cap) {
      const segs = parseCapture(cap);
      if (segs) return result(videoId, methodOf(cap), segs, started);
    }

    // 2. Transcript already rendered on the page (you had it open)? Read it
    //    directly — variant-proof, and scrolls the (virtualized) panel to get
    //    every row, restoring scroll position after. No network needed.
    if (NS.scrapeVisibleTranscript()) {
      const segs = await NS.scrapeTranscriptFull();
      if (segs) {
        clog("scraped full transcript", { segments: segs.length });
        return result(videoId, "scrape", segs, started);
      }
    }
    clog("scrape visible?", { segments: 0 });

    // 2.5 Mobile: the m.youtube.com player doesn't fetch the transcript/caption
    //     track until playback begins. onSummarizeClick already kicked playback
    //     MUTED *synchronously* within the tap gesture (autoplay policy rejects
    //     play() once we've awaited anything — the bug that made this silently
    //     do nothing). Here we just poll for the capture that playback triggers;
    //     the video is paused/restored back in onSummarizeClick's finally.
    if (!cap && location.hostname === "m.youtube.com" && mobilePlayback) {
      clog("mobile: awaiting playback-triggered capture", { playing: !mobilePlayback.v.paused });
      for (let i = 0; i < 50 && !cap; i++) { // ~15s
        await sleep(300);
        cap = await captureFor(videoId).catch(() => null);
      }
      if (cap) {
        const segs = parseCapture(cap);
        clog("mobile playback capture", { kind: cap.kind, segs: segs ? segs.length : 0 });
        if (segs) return result(videoId, methodOf(cap), segs, started);
      }
    }

    // 3. Caption-toggle trigger: flick CC on so the player fetches its own
    //    caption track (an attested request we capture at the network layer),
    //    then restore the previous CC state. Much subtler than opening the
    //    panel — and the ONLY working source on the "PAmodern" panel variant,
    //    where YouTube's own transcript panel spins forever (its get_panel
    //    response carries no segments).
    const ccBtn = document.querySelector(".ytp-subtitles-button");
    if (ccBtn && ccBtn.offsetParent) {
      const wasOn = ccBtn.getAttribute("aria-pressed") === "true";
      clog("cc toggle trigger", { wasOn });
      if (!wasOn) ccBtn.click();
      for (let i = 0; i < 20 && !cap; i++) {
        await sleep(300);
        cap = await captureFor(videoId).catch(() => null);
      }
      if (!wasOn && ccBtn.getAttribute("aria-pressed") === "true") ccBtn.click(); // restore
      if (cap) {
        const segs = parseCapture(cap);
        clog("cc capture", { kind: cap.kind, segs: segs ? segs.length : 0 });
        if (segs) return result(videoId, methodOf(cap), segs, started);
      }
    } else {
      clog("cc button not available");
    }

    // 4. Last resort: briefly open the transcript so the player fetches it, then
    //    capture (or scrape) and close the panel again. Only reached when the
    //    transcript is neither captured nor already visible.
    let opened = false, openErr = null;
    try { opened = await NS.openTranscriptPanel(); } catch (e) { openErr = e.message; }
    clog("last-resort open", { opened, openErr });
    // The "PAmodern_transcript_view" variant never renders rows (its get_panel
    // response has no segments) and only fires the capturable timedtext fetch
    // ~10s AFTER a close/reopen — so nudge it and wait the fetch out (~40s).
    const modernPanel = () => document.querySelector('[target-id*="PAmodern" i]');
    let retoggles = 0;
    for (let i = 0; i < 130; i++) {
      await sleep(300);
      cap = await captureFor(videoId).catch(() => null);
      if (cap) {
        const s = parseCapture(cap);
        if (s) { NS.closeTranscriptPanel(); clog("captured after open", { kind: cap.kind }); return result(videoId, methodOf(cap), s, started); }
      }
      if (NS.scrapeVisibleTranscript()) {
        const s = await NS.scrapeTranscriptFull();
        if (s) { NS.closeTranscriptPanel(); clog("scraped after open"); return result(videoId, "scrape", s, started); }
      }
      if (modernPanel() && retoggles < 2 && (i === 14 || i === 60)) {
        retoggles++;
        clog("modern panel nudge (close/reopen)", { retoggles });
        NS.closeTranscriptPanel();
        await sleep(400);
        try { await NS.openTranscriptPanel(); } catch {}
      }
      // Non-modern variants resolve (or fail) fast — keep the old 12s budget.
      if (!modernPanel() && i >= 40) break;
    }
    NS.closeTranscriptPanel();
    clog("last-resort open yielded nothing; trying network fallbacks");

    // 5. Network reconstruction fallbacks (usually 400/PoToken-gated, but cheap).
    const r = await NS.extractTranscript(videoId);
    document.documentElement.dataset.yapsumMethod = r.method;
    clog("fallback result", { method: r.method });
    return r;
  }

  // Assemble a diagnostic bundle: content-side step log + background ring buffer
  // + page facts. Used by the "Copy debug info" button on failures.
  async function buildDebugBundle(errorMsg) {
    let bg = null;
    try { bg = await browser.runtime.sendMessage({ type: "getDebug" }); } catch (e) { bg = { error: String(e) }; }
    const q = (s) => document.querySelectorAll(s).length;
    const btn = NS.findTranscriptButton?.() || null;

    // If scraping missed, dump a sample of elements whose text starts with a
    // timestamp — that reveals the actual transcript-row markup of this variant.
    const tsSamples = [];
    for (const el of document.querySelectorAll("*")) {
      if (tsSamples.length >= 4) break;
      const t = (el.textContent || "").trim();
      if (/^\d{1,2}:\d{2}(?::\d{2})?\s*\S/.test(t) && t.length < 200 && el.querySelectorAll("*").length <= 6) {
        tsSamples.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), html: el.outerHTML.replace(/\s+/g, " ").slice(0, 240) });
      }
    }
    let scrapeCount = 0;
    try { scrapeCount = (NS.scrapeVisibleTranscript() || []).length; } catch {}

    return {
      yapsum: "debug-v2",
      url: location.href,
      videoId: NS.currentVideoId(),
      error: errorMsg,
      ua: navigator.userAgent,
      pageFacts: {
        transcriptButtonFound: !!btn,
        transcriptButtonLabel: btn ? (btn.getAttribute("aria-label") || btn.textContent || "").trim().slice(0, 40) : null,
        genericScrapeRows: scrapeCount,
        transcriptPanelFound: !!NS.transcriptPanelInfo?.(),
        transcriptPanelInfo: NS.transcriptPanelInfo?.() || null,
        segNodes: q("ytd-transcript-segment-renderer"),
        engagementPanels: q("ytd-engagement-panel-section-list-renderer"),
        engagementPanelTargets: Array.from(document.querySelectorAll("ytd-engagement-panel-section-list-renderer"), (p) => p.getAttribute("target-id")).filter(Boolean),
        timestampRowSamples: tsSamples,
      },
      content: flow,
      background: bg,
    };
  }

  // Mobile playback nudge. MUST be kicked synchronously from the click handler:
  // the m.youtube.com player only fetches the transcript once playback starts,
  // and the browser only permits video.play() while the tap gesture is still
  // active — which it ISN'T after getTranscript's first await. So we start it
  // here (muted) and restore the video afterward (see onSummarizeClick).
  let mobilePlayback = null;
  function kickMobilePlayback() {
    mobilePlayback = null;
    if (location.hostname !== "m.youtube.com") return;
    const v = document.querySelector("video");
    if (!v) return;
    mobilePlayback = { v, wasPaused: v.paused, pos: v.currentTime, muted: v.muted };
    if (v.paused) {
      try { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch {}
    }
  }
  function restoreMobilePlayback() {
    const m = mobilePlayback;
    mobilePlayback = null;
    if (!m) return;
    try {
      if (m.wasPaused) { m.v.pause(); m.v.currentTime = m.pos; } // we started it → undo
      m.v.muted = m.muted;
    } catch {}
  }

  async function onSummarizeClick() {
    const panel = openPanel();
    panel.classList.remove("yapsum-collapsed"); // re-summarizing always expands
    setPanel(panel, "Fetching transcript…");
    kickMobilePlayback(); // synchronous — MUST stay before the first await below
    let transcript;
    try {
      transcript = await getTranscript();
    } catch (e) {
      // m.youtube.com exposes NO transcript surface at all (no panel UI, no
      // getTranscriptEndpoint, PoToken-gated timedtext — see test/probe-mobile.mjs).
      // The desktop site inside Firefox for Android works fully.
      const hint = location.hostname === "m.youtube.com"
        ? "\n\nYouTube's mobile site doesn't expose transcripts. Tap the ⋮ menu and choose \"Desktop site\", then try again."
        : "";
      await showError(panel, `Couldn't get a transcript for this video.${hint}\n\n${e.message}`);
      return;
    } finally {
      restoreMobilePlayback(); // pause + rewind the video we nudged, always
    }
    setPanel(panel, `Transcript ready (${transcript.segments.length} lines). Summarizing…`);
    const body = panel.querySelector(".yapsum-panel-body");
    const title = document.title.replace(" - YouTube", "");
    try {
      let acc = "";
      let lastRender = 0;
      const summary = await requestLLM(
        { type: "summarize", videoId: transcript.videoId, title, transcript: transcript.text },
        {
          onStage: (text) => { if (!acc) setPanel(panel, text); }, // chunked-progress, pre-stream
          onChunk: (chunk) => {
            acc += chunk;
            const now = Date.now();
            if (now - lastRender > 80) { lastRender = now; renderMarkdown(acc, body); } // live, throttled
          },
        }
      );
      const finalText = summary != null ? summary : acc;
      renderMarkdown(finalText, body); // final clean render
      mountFollowup(panel, { title, transcript: transcript.text, summary: finalText });
    } catch (e) {
      setPanel(panel, `Summary failed:\n\n${e.message}`, true);
    }
  }

  // Follow-up Q&A: a text field under the summary. Each question is sent with
  // the transcript, the summary, and prior Q&A turns; the streamed answer is
  // appended to the panel body (all rendering injection-safe).
  function mountFollowup(panel, ctx) {
    panel.querySelector(".yapsum-ask")?.remove();
    const bar = document.createElement("div");
    bar.className = "yapsum-ask";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Ask a follow-up about this video…";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Ask";
    bar.append(input, btn);
    panel.appendChild(bar);

    const body = panel.querySelector(".yapsum-panel-body");
    const qa = [];
    const ask = async () => {
      const question = input.value.trim();
      if (!question || input.disabled) return;
      input.disabled = btn.disabled = true;
      const qEl = document.createElement("p");
      qEl.className = "yapsum-qa-q";
      qEl.textContent = question; // textContent only — injection-safe
      const aEl = document.createElement("div");
      aEl.className = "yapsum-qa-a";
      aEl.textContent = "…";
      body.append(qEl, aEl);
      aEl.scrollIntoView({ block: "nearest" });
      try {
        let acc = "", lastRender = 0;
        const answer = await requestLLM(
          { type: "followup", title: ctx.title, transcript: ctx.transcript, summary: ctx.summary, qa, question },
          {
            onChunk: (c) => {
              acc += c;
              const now = Date.now();
              if (now - lastRender > 80) { lastRender = now; renderMarkdown(acc, aEl); }
            },
          }
        );
        const finalAnswer = answer != null ? answer : acc;
        renderMarkdown(finalAnswer, aEl);
        qa.push({ q: question, a: finalAnswer });
        input.value = "";
      } catch (e) {
        aEl.classList.add("yapsum-error");
        aEl.textContent = `Follow-up failed: ${e.message}`;
      }
      input.disabled = btn.disabled = false;
      input.focus();
    };
    btn.addEventListener("click", ask);
    // Keep YouTube's global hotkeys (space, k, f, …) away from the field.
    for (const ev of ["keydown", "keyup", "keypress"]) {
      input.addEventListener(ev, (e) => {
        e.stopPropagation();
        if (ev === "keydown" && e.key === "Enter") { e.preventDefault(); ask(); }
      });
    }
  }

  // ---- safe markdown rendering ----------------------------------------------
  // The summary is model output injected into YouTube's page, so we NEVER use
  // innerHTML with it. Every node is built with textContent (and hrefs are
  // scheme-checked), making injection impossible while still formatting.

  function cleanSummary(t) {
    return String(t)
      .replace(/<\|[^|>]*\|>/g, "")            // <|end_of_turn|>-style special tokens
      .replace(/<_[^>]*_>/g, "")               // <_ ... _> markers
      .replace(/\b(?:end_?of_?turn|ofturn)_?\b/gi, "")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function renderInline(text, parent) {
    const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[2] || m[3]) { const el = document.createElement("strong"); el.textContent = m[2] || m[3]; parent.appendChild(el); }
      else if (m[4]) { const el = document.createElement("em"); el.textContent = m[4]; parent.appendChild(el); }
      else if (m[5]) { const el = document.createElement("code"); el.textContent = m[5]; parent.appendChild(el); }
      else if (m[6] && m[7]) {
        if (/^https?:\/\//i.test(m[7])) {
          const a = document.createElement("a");
          a.href = m[7]; a.textContent = m[6]; a.target = "_blank"; a.rel = "noopener noreferrer";
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(m[0])); // unsafe scheme -> literal
        }
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderMarkdown(md, container) {
    container.classList.remove("yapsum-error");
    delete container.dataset.streaming;
    container.textContent = "";
    const lines = cleanSummary(md).split("\n");
    let list = null, listTag = null;
    const endList = () => { list = null; listTag = null; };
    for (const raw of lines) {
      const line = raw;
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        endList();
        const el = document.createElement("h" + Math.min(Math.max(m[1].length + 1, 3), 6)); // #→h3, ##→h3, ###→h4
        renderInline(m[2], el);
        container.appendChild(el);
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        if (listTag !== "ul") { list = document.createElement("ul"); container.appendChild(list); listTag = "ul"; }
        const li = document.createElement("li"); renderInline(m[1], li); list.appendChild(li);
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (listTag !== "ol") { list = document.createElement("ol"); container.appendChild(list); listTag = "ol"; }
        const li = document.createElement("li"); renderInline(m[1], li); list.appendChild(li);
      } else if (line.trim() === "") {
        endList();
      } else {
        endList();
        const p = document.createElement("p"); renderInline(line, p); container.appendChild(p);
      }
    }
  }

  // Ask the background script to run an LLM call (keeps the API key out of the
  // page context and centralizes provider logic). Streaming chunks arrive via
  // a port; "stage" messages report chunked-summarization progress. Returns
  // the final text.
  function requestLLM(payload, { onChunk, onStage } = {}) {
    return new Promise((resolve, reject) => {
      const port = browser.runtime.connect({ name: "summarize" });
      let acc = "";
      port.onMessage.addListener((msg) => {
        if (msg.type === "chunk") {
          acc += msg.text;
          onChunk?.(msg.text);
        } else if (msg.type === "stage") {
          onStage?.(msg.text);
        } else if (msg.type === "done") {
          resolve(msg.text ?? acc);
          port.disconnect();
        } else if (msg.type === "error") {
          reject(new Error(msg.error));
          port.disconnect();
        }
      });
      port.postMessage(payload);
    });
  }

  // ---- UI: result panel -----------------------------------------------------

  function openPanel() {
    let panel = document.getElementById("yapsum-panel");
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "yapsum-panel";
    panel.className = "yapsum-panel";
    const bar = document.createElement("div");
    bar.className = "yapsum-panel-bar";
    // Title is the collapse/expand toggle: tapping it folds the panel to a
    // compact bar at the bottom (summary + Q&A preserved, so re-opening is
    // instant — no re-fetch). Only ✕ removes it (then Summarize rebuilds).
    const title = document.createElement("span");
    title.className = "yapsum-panel-title";
    title.textContent = "Return YouTube Summary";
    title.title = "Collapse / expand";
    title.addEventListener("click", () => panel.classList.toggle("yapsum-collapsed"));
    const close = document.createElement("button");
    close.className = "yapsum-panel-close";
    close.textContent = "✕";
    close.title = "Close";
    close.addEventListener("click", () => panel.remove());
    bar.append(title, close);
    const body = document.createElement("div");
    body.className = "yapsum-panel-body";
    panel.append(bar, body);
    document.body.appendChild(panel);
    return panel;
  }

  function setPanel(panel, text, isError = false) {
    const body = panel.querySelector(".yapsum-panel-body");
    body.textContent = text;
    body.classList.toggle("yapsum-error", isError);
    delete body.dataset.streaming;
  }

  // Error state with a one-click "Copy debug info" button. Also dumps the bundle
  // to the console so it's grabbable from devtools even without clicking.
  async function showError(panel, message) {
    const bundle = await buildDebugBundle(message);
    try { console.log("[yap-sum] DEBUG BUNDLE", JSON.stringify(bundle)); } catch {}
    const body = panel.querySelector(".yapsum-panel-body");
    body.classList.add("yapsum-error");
    delete body.dataset.streaming;
    body.textContent = message + "\n\n";
    const btn = document.createElement("button");
    btn.className = "yapsum-debug-btn";
    btn.textContent = "Copy debug info";
    btn.addEventListener("click", async () => {
      const text = JSON.stringify(bundle, null, 2);
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch {
        // Fallback for contexts where the async clipboard API is blocked.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { ok = document.execCommand("copy"); } catch {}
        ta.remove();
      }
      btn.textContent = ok ? "Copied ✓ — paste it to the developer" : "Copy failed — see console";
    });
    body.appendChild(btn);
  }
  function appendPanel(panel, text) {
    const body = panel.querySelector(".yapsum-panel-body");
    if (body.dataset.streaming !== "1") {
      body.textContent = "";
      body.dataset.streaming = "1";
    }
    body.textContent += text;
  }

  // ---- lifecycle: survive SPA navigation ------------------------------------

  function onNavigate() {
    document.getElementById("yapsum-panel")?.remove();
    // button host is rebuilt by YouTube on navigation; re-inject when ready
    ensureButton();
    if (location.hash.includes("yapsum-selftest")) runSelfTest();
  }

  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", ensureButton);
  document.addEventListener("yt-navigate-finish", onNavigate);

  // Popup (browser action) can trigger a summary — the Android entry point.
  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "yapsum-summarize") onSummarizeClick();
  });

  // YouTube's polymer app rebuilds the actions row on navigation and during
  // hydration, wiping injected nodes. A MutationObserver re-adds the button
  // whenever it goes missing — more robust than a one-shot poll.
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();

  if (location.hash.includes("yapsum-selftest")) {
    // Give the page a moment to settle, then self-test.
    setTimeout(runSelfTest, 2500);
  }

  // Marker so tooling can confirm the content script is active (shared DOM).
  document.documentElement.dataset.yapsum = "loaded";
  console.log(`${LOG} content script loaded on ${location.href}`);
})();
