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

  // Primary extraction: let YouTube's player fetch the transcript and capture
  // its JSON response at the network layer (background webRequest filter), which
  // is robust to UI variants. Falls back to the extractor's DOM/network methods.
  async function getTranscript() {
    const videoId = NS.currentVideoId();
    const started = performance.now();
    try {
      await browser.runtime.sendMessage({ type: "armCapture" });
      // Maybe the player already fetched it on page load (some variants preload).
      let cap = (await browser.runtime.sendMessage({ type: "getCaptured", videoId }))?.json;
      if (!cap) {
        // Nudge the player to fetch it by opening the transcript panel.
        try { await NS.openTranscriptPanel(); } catch { /* may be preloaded/already open */ }
        for (let i = 0; i < 50 && !cap; i++) {
          await sleep(300);
          cap = (await browser.runtime.sendMessage({ type: "getCaptured", videoId }))?.json;
        }
      }
      if (cap) {
        const segs = NS.parseGetTranscriptJson(cap);
        if (segs) {
          document.documentElement.dataset.yapsumMethod = "intercept";
          return NS.buildResult(videoId, "intercept", segs, { ms: Math.round(performance.now() - started) }, []);
        }
      }
    } catch { /* fall through to the extractor's own methods */ }
    const r = await NS.extractTranscript(videoId);
    document.documentElement.dataset.yapsumMethod = r.method;
    return r;
  }

  async function onSummarizeClick() {
    const panel = openPanel();
    setPanel(panel, "Fetching transcript…");
    let transcript;
    try {
      transcript = await getTranscript();
    } catch (e) {
      setPanel(panel, `Couldn't get a transcript for this video.\n\n${e.message}`, true);
      return;
    }
    setPanel(panel, `Transcript ready (${transcript.segments.length} lines). Summarizing…`);
    try {
      const summary = await requestSummary(transcript, (chunk) => appendPanel(panel, chunk));
      if (summary != null) setPanel(panel, summary);
    } catch (e) {
      setPanel(panel, `Summary failed:\n\n${e.message}`, true);
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
