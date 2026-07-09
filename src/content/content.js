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
    btn.title = "yap-sum: summarize this video";
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
    (await browser.runtime.sendMessage({ type: "getCaptured", videoId }))?.json;

  async function getTranscript() {
    const videoId = NS.currentVideoId();
    const started = t0();
    flow = [];
    clog("start", { videoId, url: location.href });
    await browser.runtime.sendMessage({ type: "armCapture" }).catch(() => {});

    // 1. Already captured passively (the player fetched it — user opened the
    //    transcript earlier, or a prior visit). No panel interaction.
    let cap = await captureFor(videoId).catch(() => null);
    clog("passive capture?", { hit: !!cap });
    if (cap) {
      const segs = NS.parseGetTranscriptJson(cap);
      if (segs) return result(videoId, "intercept", segs, started);
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

    // 3. Last resort: briefly open the transcript so the player fetches it, then
    //    capture (or scrape) and close the panel again. Only reached when the
    //    transcript is neither captured nor already visible.
    let opened = false, openErr = null;
    try { opened = await NS.openTranscriptPanel(); } catch (e) { openErr = e.message; }
    clog("last-resort open", { opened, openErr });
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      cap = await captureFor(videoId).catch(() => null);
      if (cap) {
        const s = NS.parseGetTranscriptJson(cap);
        if (s) { NS.closeTranscriptPanel(); clog("captured after open"); return result(videoId, "intercept", s, started); }
      }
      if (NS.scrapeVisibleTranscript()) {
        const s = await NS.scrapeTranscriptFull();
        if (s) { NS.closeTranscriptPanel(); clog("scraped after open"); return result(videoId, "scrape", s, started); }
      }
    }
    NS.closeTranscriptPanel();
    clog("last-resort open yielded nothing; trying network fallbacks");

    // 4. Network reconstruction fallbacks (usually 400/PoToken-gated, but cheap).
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
    let btn = document.querySelector('button[aria-label*="transcript" i]');
    if (!btn) btn = Array.from(document.querySelectorAll("button, tp-yt-paper-button, yt-button-shape")).find((x) => /transcript/i.test(x.getAttribute("aria-label") || x.textContent || ""));

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

  async function onSummarizeClick() {
    const panel = openPanel();
    setPanel(panel, "Fetching transcript…");
    let transcript;
    try {
      transcript = await getTranscript();
    } catch (e) {
      await showError(panel, `Couldn't get a transcript for this video.\n\n${e.message}`);
      return;
    }
    setPanel(panel, `Transcript ready (${transcript.segments.length} lines). Summarizing…`);
    const body = panel.querySelector(".yapsum-panel-body");
    try {
      let acc = "";
      let lastRender = 0;
      const summary = await requestSummary(transcript, (chunk) => {
        acc += chunk;
        const now = Date.now();
        if (now - lastRender > 80) { lastRender = now; renderMarkdown(acc, body); } // live, throttled
      });
      renderMarkdown(summary != null ? summary : acc, body); // final clean render
    } catch (e) {
      setPanel(panel, `Summary failed:\n\n${e.message}`, true);
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

  // Ask the background script to run the LLM call (keeps the API key out of the
  // page context and centralizes provider logic). Streaming chunks arrive via
  // a port; returns the final text.
  function requestSummary(transcript, onChunk) {
    return new Promise((resolve, reject) => {
      const port = browser.runtime.connect({ name: "summarize" });
      let acc = "";
      port.onMessage.addListener((msg) => {
        if (msg.type === "chunk") {
          acc += msg.text;
          onChunk?.(msg.text);
        } else if (msg.type === "done") {
          resolve(msg.text ?? acc);
          port.disconnect();
        } else if (msg.type === "error") {
          reject(new Error(msg.error));
          port.disconnect();
        }
      });
      port.postMessage({
        type: "summarize",
        videoId: transcript.videoId,
        title: document.title.replace(" - YouTube", ""),
        transcript: transcript.text,
      });
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
    bar.innerHTML = '<span>yap-sum</span>';
    const close = document.createElement("button");
    close.className = "yapsum-panel-close";
    close.textContent = "✕";
    close.addEventListener("click", () => panel.remove());
    bar.appendChild(close);
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
