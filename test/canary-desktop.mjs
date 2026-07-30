#!/usr/bin/env node
import { createHarness, sleep } from "./lib/harness.mjs";
import { contractFor } from "./contract.mjs";
import { Report } from "./lib/report.mjs";

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };
const VIDEO = argOf("--video", "eIho2S0ZahI");

const report = new Report("canary-desktop", { video: VIDEO, surface: "desktop" });

const sel = (id) => contractFor(id).expr;

const CONTENT = `
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const q = (s) => document.querySelector(s);
  const player = () => q("#movie_player");
  const api = () => { const p = player(); return p && (p.wrappedJSObject || p); };

  onCmd("facts", () => {
    const v = document.querySelector("video");
    return {
      videoPresent: !!v,
      paused: v ? v.paused : null,
      videoId: new URLSearchParams(location.search).get("v"),
      playerVideoId: safe(() => api().getVideoData().video_id, null),
      hasMoviePlayer: !!player(),
      likeViewModel: !!q(${JSON.stringify(sel("desktop-like-viewmodel"))}),
      likeLegacy: !!q(${JSON.stringify(sel("desktop-like-renderer-legacy"))}),
      actionsScoped: !!q(${JSON.stringify(sel("desktop-actions-scoped"))}),
      ownerAnchor: !!q(${JSON.stringify(sel("desktop-owner-anchor"))}),
      ccButton: !!q(${JSON.stringify(sel("desktop-cc-button"))}),
      ccPressed: safe(() => q(${JSON.stringify(sel("desktop-cc-button"))}).getAttribute("aria-pressed"), null),
      descExpander: !!q(${JSON.stringify(sel("description-expander-selector"))}),
      transcriptButton: !!(globalThis.yapSum && globalThis.yapSum.findTranscriptButton && globalThis.yapSum.findTranscriptButton()),
      engagementPanels: document.querySelectorAll("ytd-engagement-panel-section-list-renderer").length,
      panelTargets: [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")]
        .map((p) => p.getAttribute("target-id")).filter(Boolean).slice(0, 10),
      innertubeKey: /"INNERTUBE_API_KEY":"([^"]+)"/.test(document.documentElement.innerHTML),
      captionTracks: /"captionTracks":/.test(document.documentElement.innerHTML),
      getTranscriptParams: /"getTranscriptEndpoint":\\s*\\{"params":"/.test(document.documentElement.innerHTML),
    };
  });

  onCmd("openTranscript", async () => {
    if (!globalThis.yapSum) return { err: "extractor not loaded" };
    try {
      await globalThis.yapSum.openTranscriptPanel();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const rows = (globalThis.yapSum.scrapeVisibleTranscript() || []).length;
        if (rows > 3) return { rows, info: globalThis.yapSum.transcriptPanelInfo() };
      }
      return { rows: 0, info: globalThis.yapSum.transcriptPanelInfo() };
    } catch (e) { return { err: String(e) }; }
  });
`;

const h = createHarness({
  target: "desktop",
  site: "desktop",
  bare: false,
  observe: ["timedtext", "get_transcript"],
  content: CONTENT,
  closeExistingTabs: false,
});

try {
  await h.start({ startUrl: `https://www.youtube.com/watch?v=${VIDEO}` });

  const facts = await h.waitFor(async () => {
    const f = await h.call("facts", null, { match: VIDEO, timeoutMs: 8000 });
    return f && f.videoPresent ? f : null;
  }, 90000, "watch page");
  if (!facts) throw new Error("INFRA: desktop watch page never reported a video element");

  report.check("videoid-query-param", facts.videoId === VIDEO, { url: facts.videoId, player: facts.playerVideoId });
  report.check("movie-player-element-id", facts.hasMoviePlayer, {});
  report.check("desktop-like-viewmodel", facts.likeViewModel || facts.likeLegacy, {
    viewModel: facts.likeViewModel,
    legacy: facts.likeLegacy,
    note: "the Summarize button anchors to the like rail; losing both moves it under the channel name",
  });
  report.check("desktop-actions-scoped", facts.actionsScoped, {});
  report.check("desktop-owner-anchor", facts.ownerAnchor, {});
  report.check("desktop-cc-button", facts.ccButton, { pressed: facts.ccPressed });
  report.check("desktop-cc-aria-pressed", facts.ccPressed === "true" || facts.ccPressed === "false", { value: facts.ccPressed });
  report.check("description-expander-selector", facts.descExpander, {});
  report.check("innertube-api-key-regex", facts.innertubeKey, {});
  report.check("caption-tracks-array-anchor", facts.captionTracks, {});
  report.check("get-transcript-endpoint-params-regex", facts.getTranscriptParams, {
    note: "the get_transcript fallback needs these params; absence means that fallback is dead",
  });

  const netMark = h.mark();
  const panel = await h.call("openTranscript", null, { match: VIDEO, timeoutMs: 40000 });
  report.note("panel", panel);
  report.check("transcript-button-aria-primary", facts.transcriptButton || (panel && panel.rows > 3), {
    buttonFound: facts.transcriptButton,
    rows: panel ? panel.rows : null,
  });
  report.check("timestamp-leaf-regex", !!(panel && panel.rows > 3), {
    rows: panel ? panel.rows : null,
    note: "the DOM scraper is the only surviving desktop fallback; zero rows means it is dead",
  });

  await sleep(3000);
  const gt = h.since("net-request", netMark).filter((e) => e.ep === "get_transcript");
  const gtBodies = h.since("net-body", netMark).filter((e) => e.ep === "get_transcript");
  report.check("gt-url-pattern", gt.length > 0, {
    seen: gt.length,
    note: "opening the transcript panel should make the player call get_transcript; this is the desktop capture path",
  });
  report.check("gt-segment-renderer-marker", gtBodies.some((b) => b.segs > 0), {
    bodies: gtBodies.map((b) => ({ bytes: b.bytes, segs: b.segs, parseErr: b.parseErr })),
  });
} catch (e) {
  report.fatal(e);
} finally {
  await h.stop();
}

process.exit(report.finish());
