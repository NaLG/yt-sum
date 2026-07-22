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

  function isShortsPage() {
    return location.pathname.startsWith("/shorts/");
  }

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

  function buttonHost() {
    const usable = (el) => {
      if (!el || el.closest("#player, ytd-player, #movie_player, .html5-video-player, yt-player-quick-action-buttons")) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? el : null;
    };
    let likeComponent =
      usable(document.querySelector("ytd-watch-metadata segmented-like-dislike-button-view-model")) ||
      usable(document.querySelector("ytd-watch-metadata ytd-segmented-like-dislike-button-renderer")) ||
      usable(document.querySelector("ytm-slim-video-action-bar-renderer ytm-like-button-renderer"));
    if (!likeComponent) {
      for (const c of document.querySelectorAll("like-button-view-model, ytm-like-button-renderer")) {
        if ((likeComponent = usable(c))) break;
      }
    }
    if (!likeComponent) {
      for (const b of [...document.querySelectorAll("button[aria-label]")].slice(0, 80)) {
        if (/^like\b/i.test(b.getAttribute("aria-label") || "") && (likeComponent = usable(b))) break;
      }
    }
    if (likeComponent) {
      let el = likeComponent;
      for (let depth = 0; el.parentElement && depth < 4; depth++) {
        const p = el.parentElement;
        const likeDislikePill =
          p.children.length === 2 && p.querySelector('button[aria-label*="islike"]');
        if (p.children.length === 1 || likeDislikePill) { el = p; continue; }
        break;
      }
      return { el, place: "before" };
    }
    const owner = document.querySelector("ytd-watch-metadata #owner");
    if (owner) return { el: owner, place: "append" };
    const mSub =
      document.querySelector("ytm-subscribe-button-renderer, yt-subscribe-button-view-model") ||
      [...document.querySelectorAll("button")].slice(0, 40)
        .find((b) => /^(subscribe|subscribed)$/i.test((b.textContent || "").trim())) ||
      null;
    if (mSub) return { el: mSub, place: "after" };
    const mOwner = document.querySelector("ytm-slim-owner-renderer");
    if (mOwner) return { el: mOwner, place: "append" };
    const el =
      document.querySelector("ytd-watch-metadata #actions #top-level-buttons-computed") ||
      document.querySelector("#actions #top-level-buttons-computed") ||
      document.querySelector("#actions-inner #top-level-buttons-computed") ||
      document.querySelector("ytm-slim-video-action-bar-renderer") ||
      document.querySelector("#actions-inner") ||
      null;
    return el ? { el, place: "prepend" } : null;
  }

  const normStyle = (v) => (v === "icon" || v === "tldw" || v === "sum" ? v : "text");
  let buttonStyle = "text";
  let shortsButton = false;
  let collapseInPlace = false;
  let autoSummarize = true;
  browser.storage.local.get({ buttonStyle: "text", shortsButton: false, collapseInPlace: false, autoSummarize: true }).then((s) => {
    const changed = normStyle(s.buttonStyle) !== buttonStyle || !!s.shortsButton !== shortsButton;
    buttonStyle = normStyle(s.buttonStyle);
    shortsButton = !!s.shortsButton;
    collapseInPlace = !!s.collapseInPlace;
    autoSummarize = s.autoSummarize !== false;
    if (changed) {
      document.getElementById("yapsum-btn")?.remove();
      ensureButton();
    }
  }).catch(() => {});
  browser.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.collapseInPlace) collapseInPlace = !!ch.collapseInPlace.newValue;
    if (ch.autoSummarize) autoSummarize = ch.autoSummarize.newValue !== false;
    if (ch.extraModels || ch.model) {
      const panel = document.getElementById("yapsum-panel");
      if (panel) refreshModelPicker(panel);
    }
    if (!ch.buttonStyle && !ch.shortsButton) return;
    if (ch.buttonStyle) buttonStyle = normStyle(ch.buttonStyle.newValue);
    if (ch.shortsButton) shortsButton = !!ch.shortsButton.newValue;
    document.getElementById("yapsum-btn")?.remove();
    ensureButton();
  });

  function ensureButton() {
    const onShorts = isShortsPage();
    if (onShorts && !shortsButton) { document.getElementById("yapsum-btn")?.remove(); return; }
    if (!isWatchPage()) return;
    const host = buttonHost();
    if (!host) return;
    const existing = document.getElementById("yapsum-btn");
    const placedRight = existing && existing.isConnected &&
      (host.place === "after" ? existing.previousElementSibling === host.el
        : host.place === "before" ? existing.nextElementSibling === host.el
        : existing.parentElement === host.el);
    if (placedRight) return;
    if (existing) existing.remove();
    const btn = document.createElement("button");
    btn.id = "yapsum-btn";
    btn.className = "yapsum-btn";
    btn.title = "Summarize this video";
    if (onShorts || buttonStyle === "icon") {
      btn.classList.add("yapsum-btn-icon");
      if (onShorts) btn.classList.add("yapsum-btn-shorts");
      btn.setAttribute("aria-label", "Summarize");
      const img = document.createElement("img");
      img.src = browser.runtime.getURL("icons/icon-48.png");
      img.alt = "Summarize";
      btn.appendChild(img);
    } else if (buttonStyle === "tldw" || buttonStyle === "sum") {
      btn.classList.add("yapsum-btn-tldw");
      btn.setAttribute("aria-label", "Summarize");
      btn.textContent = buttonStyle === "sum" ? "Sum" : "TL;DW";
    } else {
      btn.textContent = "Summarize";
    }
    btn.addEventListener("click", onSummarizeClick);
    const mobile = location.hostname === "m.youtube.com";
    if (mobile) btn.classList.add("yapsum-btn-mrow");
    if (host.place === "after") host.el.insertAdjacentElement("afterend", btn);
    else if (host.place === "before") host.el.insertAdjacentElement("beforebegin", btn);
    else host.el[host.place](btn);
    console.log(`${LOG} button ${host.place} <${host.el.tagName.toLowerCase()}>`, {
      dOwner: !!document.querySelector("ytd-watch-metadata #owner"),
      mSubTag: !!document.querySelector("ytm-subscribe-button-renderer, yt-subscribe-button-view-model"),
      mOwner: !!document.querySelector("ytm-slim-owner-renderer"),
      slimBar: !!document.querySelector("ytm-slim-video-action-bar-renderer"),
    });
    if (mobile && !onShorts && buttonStyle === "text") {
      requestAnimationFrame(() => {
        const row = btn.parentElement;
        if (row && row.scrollWidth > row.clientWidth + 1) btn.textContent = "Sum";
      });
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let flow = [];
  function clog(m, x) {
    flow.push({ t: Date.now(), m, ...(x || {}) });
    try { console.log("[yap-sum]", m, x || ""); } catch {}
  }

  const t0 = () => performance.now();
  function result(videoId, method, segs, started) {
    document.documentElement.dataset.yapsumMethod = method;
    return NS.buildResult(videoId, method, segs, { ms: Math.round(performance.now() - started) }, []);
  }
  const captureFor = async (videoId) =>
    (await browser.runtime.sendMessage({ type: "getCaptured", videoId }))?.capture;
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

    let cap = await captureFor(videoId).catch(() => null);
    clog("passive capture?", { hit: !!cap, kind: cap?.kind });
    if (cap) {
      const segs = parseCapture(cap);
      if (segs) return result(videoId, methodOf(cap), segs, started);
    }

    if (NS.scrapeVisibleTranscript()) {
      const segs = await NS.scrapeTranscriptFull();
      if (segs) {
        clog("scraped full transcript", { segments: segs.length });
        return result(videoId, "scrape", segs, started);
      }
    }
    clog("scrape visible?", { segments: 0 });

    if (!cap && location.hostname === "m.youtube.com" && mobilePlayback) {
      clog("mobile: awaiting playback-triggered capture", { playing: !mobilePlayback.v.paused });
      for (let i = 0; i < 115 && !cap; i++) {
        await sleep(300);
        cap = await captureFor(videoId).catch(() => null);
      }
      if (cap) {
        const segs = parseCapture(cap);
        clog("mobile playback capture", { kind: cap.kind, segs: segs ? segs.length : 0 });
        if (segs) return result(videoId, methodOf(cap), segs, started);
      }
    }

    const ccBtn = document.querySelector(".ytp-subtitles-button");
    if (ccBtn && ccBtn.offsetParent) {
      const wasOn = ccBtn.getAttribute("aria-pressed") === "true";
      clog("cc toggle trigger", { wasOn });
      if (!wasOn) ccBtn.click();
      for (let i = 0; i < 20 && !cap; i++) {
        await sleep(300);
        cap = await captureFor(videoId).catch(() => null);
      }
      if (!wasOn && ccBtn.getAttribute("aria-pressed") === "true") ccBtn.click();
      if (cap) {
        const segs = parseCapture(cap);
        clog("cc capture", { kind: cap.kind, segs: segs ? segs.length : 0 });
        if (segs) return result(videoId, methodOf(cap), segs, started);
      }
    } else {
      clog("cc button not available");
    }

    if (location.hostname !== "m.youtube.com") {
      let opened = false, openErr = null;
      try { opened = await NS.openTranscriptPanel(); } catch (e) { openErr = e.message; }
      clog("last-resort open", { opened, openErr });
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
        if (!modernPanel() && i >= 40) break;
      }
      NS.closeTranscriptPanel();
    }
    clog("last-resort open yielded nothing; trying network fallbacks");

    const r = await NS.extractTranscript(videoId);
    document.documentElement.dataset.yapsumMethod = r.method;
    clog("fallback result", { method: r.method });
    return r;
  }

  async function buildDebugBundle(errorMsg) {
    let bg = null;
    try { bg = await browser.runtime.sendMessage({ type: "getDebug" }); } catch (e) { bg = { error: String(e) }; }
    const q = (s) => document.querySelectorAll(s).length;
    const btn = NS.findTranscriptButton?.() || null;

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

    let pickerModels = null;
    try { pickerModels = await browser.runtime.sendMessage({ type: "getModels" }); } catch {}

    return {
      yapsum: "debug-v2",
      version: browser.runtime.getManifest().version,
      url: location.href,
      videoId: NS.currentVideoId(),
      error: errorMsg,
      ua: navigator.userAgent,
      picker: {
        mounted: !!document.querySelector("#yapsum-panel .yapsum-model"),
        activeModelId,
        defaultModel: pickerModels?.defaultModel ?? null,
        extraCount: pickerModels?.extra?.length ?? null,
      },
      pageFacts: {
        summarizeBtnParent: document.getElementById("yapsum-btn")?.parentElement?.tagName?.toLowerCase() || null,
        summarizeBtnPrevSibling: document.getElementById("yapsum-btn")?.previousElementSibling?.tagName?.toLowerCase() || null,
        subscribeAnchors: ["ytm-subscribe-button-renderer", "yt-subscribe-button-view-model", "ytm-slim-owner-renderer", "ytd-watch-metadata #owner"].filter((s) => document.querySelector(s)),
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
      if (m.wasPaused) { m.v.pause(); m.v.currentTime = m.pos; }
      m.v.muted = m.muted;
    } catch {}
  }

  const SUMMARY_TTL_MS = 30 * 60 * 1000;
  const SUMMARY_CACHE_MAX = 10;
  const summaryCache = new Map();
  function cachedSummary(key) {
    const e = summaryCache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > SUMMARY_TTL_MS) { summaryCache.delete(key); return null; }
    e.ts = Date.now();
    return e;
  }
  function rememberSummary(key, entry) {
    summaryCache.delete(key);
    entry.ts = Date.now(); // stored by reference: waiting entries and qa arrays mutate in place
    summaryCache.set(key, entry);
    for (const k of summaryCache.keys()) {
      if (summaryCache.size <= SUMMARY_CACHE_MAX) break;
      summaryCache.delete(k);
    }
  }

  let activeModelId = null;
  let pickerVideoId = null;

  function modelSig(models) {
    if (activeModelId) {
      const e = models.extra.find((m) => m.id === activeModelId);
      if (e) return `x:${e.id}:${e.model}`;
      activeModelId = null;
    }
    return `d:${models.defaultModel}`;
  }
  function activeModelLabel(models) {
    const e = activeModelId && models.extra.find((m) => m.id === activeModelId);
    return e ? e.label : models.defaultLabel || models.defaultModel || "default model";
  }

  async function refreshModelPicker(panel) {
    let models = null;
    try { models = await browser.runtime.sendMessage({ type: "getModels" }); } catch {}
    if (!models || !Array.isArray(models.extra)) {
      try {
        const s = await browser.storage.local.get({ model: "", label: "", extraModels: [] });
        models = {
          defaultModel: s.model,
          defaultLabel: s.label || s.model,
          extra: (s.extraModels || []).filter((m) => m && m.id && m.model)
            .map((m) => ({ id: m.id, label: m.label || m.model, model: m.model })),
        };
      } catch {
        models = { defaultModel: "", extra: [] };
      }
    }
    if (currentVideoId() !== pickerVideoId) { pickerVideoId = currentVideoId(); activeModelId = null; }
    const bar = panel.querySelector(".yapsum-panel-bar");
    let sel = bar.querySelector(".yapsum-model");
    if (!models.extra.length) activeModelId = null;
    if (!sel) {
      sel = document.createElement("select");
      sel.className = "yapsum-model";
      sel.title = "Model for this summary";
      for (const ev of ["pointerdown", "click"]) sel.addEventListener(ev, (e) => e.stopPropagation());
      sel.addEventListener("change", () => {
        if (sel.disabled) return;
        activeModelId = sel.value || null;
        onSummarizeClick();
      });
      bar.insertBefore(sel, bar.querySelector(".yapsum-panel-close"));
    }
    sel.innerHTML = "";
    const d = document.createElement("option");
    d.value = "";
    d.textContent = models.defaultLabel || models.defaultModel;
    sel.appendChild(d);
    for (const m of models.extra) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.label;
      sel.appendChild(o);
    }
    if (activeModelId && !models.extra.some((m) => m.id === activeModelId)) activeModelId = null;
    sel.value = activeModelId || "";
    return models;
  }

  function setPickerDisabled(panel, disabled) {
    const sel = panel.querySelector(".yapsum-model");
    if (sel) sel.disabled = disabled;
  }

  async function onSummarizeClick() {
    const panel = openPanel();
    setCollapsed(panel, false);
    const models = await refreshModelPicker(panel);
    const sig = modelSig(models);
    const key = `${currentVideoId()}::${sig}`;
    const cached = cachedSummary(key);
    if (cached && cached.summary) {
      setPanel(panel, "");
      renderMarkdown(cached.summary, panel.querySelector(".yapsum-panel-body"));
      mountFollowup(panel, cached);
      return;
    }
    if (!autoSummarize) {
      const entry = cached || { title: document.title.replace(" - YouTube", ""), transcript: null, summary: "", qa: [], modelId: activeModelId };
      if (!cached) rememberSummary(key, entry);
      renderWaiting(panel, models, sig, entry);
      return;
    }
    await runSummarize(panel, models, sig, cached);
  }

  function renderWaiting(panel, models, sig, entry) {
    const body = panel.querySelector(".yapsum-panel-body");
    body.classList.remove("yapsum-error");
    body.textContent = "";
    const run = document.createElement("button");
    run.type = "button";
    run.className = "yapsum-run-btn";
    run.textContent = "Summarize this video";
    run.addEventListener("click", () => runSummarize(panel, models, sig, entry));
    body.append(run);
    mountFollowup(panel, entry);
  }

  async function runSummarize(panel, models, sig, entry) {
    setPickerDisabled(panel, true);
    setPanel(panel, "Fetching transcript…");
    kickMobilePlayback(); // must stay before the first await: it needs the user-gesture context
    const playHint = setTimeout(() => {
      const v = document.querySelector("video");
      if (location.hostname === "m.youtube.com" || !v || v.paused)
        setPanel(panel, "Fetching transcript…\nTip: play the video to load the transcript.");
    }, 2500);
    let transcript;
    try {
      transcript = await getTranscript();
    } catch (e) {
      const hint = isShortsPage()
        ? "\n\nLet the short play for a few seconds, then try again. Note that many Shorts have no captions at all; those can't be summarized."
        : location.hostname === "m.youtube.com"
          ? "\n\nTry playing the video for a few seconds, then tap Summarize again. If that still fails, tap the ⋮ menu, choose \"Desktop site\", and retry."
          : "";
      await showError(panel, `Couldn't get a transcript for this video.${hint}\n\n${e.message}`);
      setPickerDisabled(panel, false);
      return;
    } finally {
      clearTimeout(playHint);
      restoreMobilePlayback();
    }
    setPanel(panel, `Transcript ready (${transcript.segments.length} lines). Summarizing with ${activeModelLabel(models)}…`);
    const body = panel.querySelector(".yapsum-panel-body");
    const title = document.title.replace(" - YouTube", "");
    try {
      let acc = "";
      let lastRender = 0;
      const notices = [];
      const summary = await requestLLM(
        { type: "summarize", videoId: transcript.videoId, title, transcript: transcript.text, modelId: activeModelId },
        {
          onStage: (text) => { if (!acc) setPanel(panel, text); },
          onChunk: (chunk) => {
            acc += chunk;
            const now = Date.now();
            if (now - lastRender > 80) { lastRender = now; renderMarkdown(acc, body); }
          },
          onNotice: (text) => notices.push(text),
        }
      );
      const finalText = summary != null ? summary : acc;
      renderMarkdown(finalText, body);
      for (const n of notices) appendNotice(body, n);
      const qa = entry?.qa || [];
      const done = { title, transcript: transcript.text, summary: finalText, qa, modelId: activeModelId };
      mountFollowup(panel, done);
      rememberSummary(`${transcript.videoId}::${sig}`, done);
    } catch (e) {
      setPanel(panel, `Summary failed:\n\n${e.message}`, true);
    }
    setPickerDisabled(panel, false);
  }

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
    const qa = ctx.qa || (ctx.qa = []);
    for (const turn of qa) {
      const qEl = document.createElement("p");
      qEl.className = "yapsum-qa-q";
      qEl.textContent = turn.q;
      const aEl = document.createElement("div");
      aEl.className = "yapsum-qa-a";
      renderMarkdown(turn.a, aEl);
      body.append(qEl, aEl);
    }
    const ask = async () => {
      const question = input.value.trim();
      if (!question || input.disabled) return;
      input.disabled = btn.disabled = true;
      const qEl = document.createElement("p");
      qEl.className = "yapsum-qa-q";
      qEl.textContent = question;
      const aEl = document.createElement("div");
      aEl.className = "yapsum-qa-a";
      aEl.textContent = "…";
      body.append(qEl, aEl);
      aEl.scrollIntoView({ block: "nearest" });
      try {
        if (!ctx.transcript) {
          kickMobilePlayback(); // before the first await: it needs the user-gesture context
          aEl.textContent = "Fetching transcript…";
          const playHint = setTimeout(() => {
            const v = document.querySelector("video");
            if (location.hostname === "m.youtube.com" || !v || v.paused)
              aEl.textContent = "Fetching transcript…\nTip: play the video to load the transcript.";
          }, 2500);
          try {
            ctx.transcript = (await getTranscript()).text;
          } finally {
            clearTimeout(playHint);
            restoreMobilePlayback();
          }
          aEl.textContent = "…";
        }
        let acc = "", lastRender = 0;
        const notices = [];
        const answer = await requestLLM(
          { type: "followup", title: ctx.title, transcript: ctx.transcript, summary: ctx.summary, qa, question, modelId: ctx.modelId || null },
          {
            onChunk: (c) => {
              acc += c;
              const now = Date.now();
              if (now - lastRender > 80) { lastRender = now; renderMarkdown(acc, aEl); }
            },
            onNotice: (text) => notices.push(text),
          }
        );
        const finalAnswer = answer != null ? answer : acc;
        renderMarkdown(finalAnswer, aEl);
        for (const n of notices) appendNotice(aEl, n);
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
    for (const ev of ["keydown", "keyup", "keypress"]) {
      input.addEventListener(ev, (e) => {
        e.stopPropagation();
        if (ev === "keydown" && e.key === "Enter") { e.preventDefault(); ask(); }
      });
    }
  }

  function cleanSummary(t) {
    return String(t)
      .replace(/<\|[^|>]*\|>/g, "")
      .replace(/<_[^>]*_>/g, "")
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
          parent.appendChild(document.createTextNode(m[0]));
        }
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // model output only ever enters the DOM via textContent
  function renderMarkdown(md, container) {
    container.classList.remove("yapsum-error");
    container.textContent = "";
    const lines = cleanSummary(md).split("\n");
    let list = null, listTag = null;
    const endList = () => { list = null; listTag = null; };
    for (const raw of lines) {
      const line = raw;
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        endList();
        const el = document.createElement("h" + Math.min(Math.max(m[1].length + 1, 3), 6));
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

  function appendNotice(container, text) {
    const p = document.createElement("p");
    p.className = "yapsum-note";
    p.textContent = text;
    container.appendChild(p);
  }

  function requestLLM(payload, { onChunk, onStage, onNotice } = {}) {
    return new Promise((resolve, reject) => {
      const port = browser.runtime.connect({ name: "summarize" });
      let acc = "";
      port.onMessage.addListener((msg) => {
        if (msg.type === "chunk") {
          acc += msg.text;
          onChunk?.(msg.text);
        } else if (msg.type === "stage") {
          onStage?.(msg.text);
        } else if (msg.type === "notice") {
          onNotice?.(msg.text);
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

  const PANEL_MIN_W = 280, PANEL_MIN_H = 140, DRAG_SLOP = 4;
  const panelAdjustable = () => location.hostname !== "m.youtube.com";
  let panelGeom = null;

  function applyPanelGeom(panel) {
    const g = panelGeom;
    if (!g || !panelAdjustable()) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (g.width != null) g.width = Math.max(PANEL_MIN_W, Math.min(g.width, vw - 16));
    if (g.height != null) g.height = Math.max(PANEL_MIN_H, Math.min(g.height, vh - 16));
    const w = g.width != null ? g.width : Math.min(420, vw - 32);
    g.left = Math.max(80 - w, Math.min(g.left, vw - 80));
    g.top = Math.max(0, Math.min(g.top, vh - 44));
    panel.style.left = g.left + "px";
    panel.style.top = g.top + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.width = g.width != null ? g.width + "px" : "";
    if (g.height != null && !panel.classList.contains("yapsum-collapsed")) {
      panel.style.height = g.height + "px";
      panel.style.maxHeight = "none";
    }
  }

  function setCollapsed(panel, collapsed) {
    const inplace = collapsed && collapseInPlace && panelAdjustable();
    panel.classList.toggle("yapsum-collapsed", collapsed);
    panel.classList.toggle("yapsum-inplace", inplace);
    if (!panelAdjustable()) return;
    if (!collapsed) { applyPanelGeom(panel); return; }
    if (inplace) {
      panel.style.height = "";
      panel.style.maxHeight = "";
    } else {
      for (const p of ["left", "top", "right", "bottom", "width", "height", "maxHeight"]) panel.style[p] = "";
    }
  }

  function dragSession(el, e, step, done) {
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_SLOP) return;
      moved = true;
      step(ev.clientX - sx, ev.clientY - sy);
    };
    const onEnd = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onEnd);
      el.removeEventListener("pointercancel", onEnd);
      if (done) done(moved);
    };
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onEnd);
    el.addEventListener("pointercancel", onEnd);
  }

  function wirePanelBar(panel, bar, closeBtn) {
    let swallowClick = false;
    bar.addEventListener("click", (e) => {
      if (closeBtn.contains(e.target)) return;
      if (swallowClick) { swallowClick = false; return; }
      setCollapsed(panel, !panel.classList.contains("yapsum-collapsed"));
    });
    if (!panelAdjustable()) return;
    bar.style.touchAction = "none";

    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || closeBtn.contains(e.target)) return;
      if (panel.classList.contains("yapsum-collapsed") && !panel.classList.contains("yapsum-inplace")) return;
      const r = panel.getBoundingClientRect();
      dragSession(bar, e, (dx, dy) => {
        panelGeom = {
          width: null, height: null, ...panelGeom,
          left: r.left + dx, top: r.top + dy,
        };
        applyPanelGeom(panel);
      }, (moved) => {
        swallowClick = moved;
        setTimeout(() => { swallowClick = false; }, 0);
      });
    });

    for (const dir of ["w", "e", "s", "nw", "ne", "sw", "se"]) {
      const grip = document.createElement("div");
      grip.className = `yapsum-rs yapsum-rs-${dir}`;
      grip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const r = panel.getBoundingClientRect();
        dragSession(grip, e, (dx, dy) => {
          const g = {
            left: r.left, top: r.top,
            width: panelGeom ? panelGeom.width : null,
            height: panelGeom ? panelGeom.height : null,
          };
          if (dir.includes("e")) g.width = r.width + dx;
          if (dir.includes("w")) g.width = r.width - dx;
          if (dir.includes("s")) g.height = r.height + dy;
          if (dir.includes("n")) g.height = r.height - dy;
          if (g.width != null) g.width = Math.max(PANEL_MIN_W, Math.min(g.width, window.innerWidth - 16));
          if (g.height != null) g.height = Math.max(PANEL_MIN_H, Math.min(g.height, window.innerHeight - 16));
          if (dir.includes("w")) g.left = r.right - g.width;
          if (dir.includes("n")) g.top = r.bottom - g.height;
          panelGeom = g;
          applyPanelGeom(panel);
        });
      });
      panel.appendChild(grip);
    }
  }

  function openPanel() {
    let panel = document.getElementById("yapsum-panel");
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "yapsum-panel";
    panel.className = "yapsum-panel";
    const bar = document.createElement("div");
    bar.className = "yapsum-panel-bar";
    const title = document.createElement("span");
    title.className = "yapsum-panel-title";
    title.textContent = "TL;DW";
    title.title = "Collapse / expand";
    const close = document.createElement("button");
    close.className = "yapsum-panel-close";
    close.textContent = "✕";
    close.title = "Close";
    close.addEventListener("click", () => panel.remove());
    bar.append(title, close);
    const body = document.createElement("div");
    body.className = "yapsum-panel-body";
    panel.append(bar, body);
    wirePanelBar(panel, bar, close);
    document.body.appendChild(panel);
    applyPanelGeom(panel);
    return panel;
  }

  function setPanel(panel, text, isError = false) {
    const body = panel.querySelector(".yapsum-panel-body");
    body.textContent = text;
    body.classList.toggle("yapsum-error", isError);
  }

  async function showError(panel, message) {
    const bundle = await buildDebugBundle(message);
    try { console.log("[yap-sum] DEBUG BUNDLE", JSON.stringify(bundle)); } catch {}
    const body = panel.querySelector(".yapsum-panel-body");
    body.classList.add("yapsum-error");
    body.textContent = message + "\n\n";
    const btn = document.createElement("button");
    btn.className = "yapsum-debug-btn";
    btn.textContent = "Copy debug info";
    btn.addEventListener("click", async () => {
      const text = JSON.stringify(bundle, null, 2);
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { ok = document.execCommand("copy"); } catch {}
        ta.remove();
      }
      btn.textContent = ok ? "Copied ✓, paste it to the developer" : "Copy failed, see console";
    });
    body.appendChild(btn);
  }

  let lastNavHref = location.href;
  let lastNavVid = currentVideoId();
  function onNavigate() {
    lastNavHref = location.href;
    lastNavVid = currentVideoId();
    document.getElementById("yapsum-panel")?.remove();
    ensureButton();
    if (location.hash.includes("yapsum-selftest")) runSelfTest();
  }

  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", ensureButton);
  document.addEventListener("yt-navigate-finish", onNavigate);

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "yapsum-summarize") onSummarizeClick();
  });

  const observer = new MutationObserver(() => {
    if (location.href !== lastNavHref) {
      lastNavHref = location.href;
      if (currentVideoId() !== lastNavVid) onNavigate();
    }
    ensureButton();
  });
  // a previous script generation's UI has dead listeners; updates self-heal open tabs
  document.getElementById("yapsum-btn")?.remove();
  document.getElementById("yapsum-panel")?.remove();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();

  if (location.hash.includes("yapsum-selftest")) {
    setTimeout(runSelfTest, 2500);
  }

  document.documentElement.dataset.yapsum = "loaded";
  console.log(`${LOG} content script v${browser.runtime.getManifest().version} loaded on ${location.href}`);
})();
