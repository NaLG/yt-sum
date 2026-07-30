#!/usr/bin/env node
import { createHarness, sleep } from "./lib/harness.mjs";
import * as android from "./lib/android.mjs";
import { contractFor, contractSelectors } from "./contract.mjs";
import { Report } from "./lib/report.mjs";

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };
const VIDEO = argOf("--video", "eIho2S0ZahI");
const QUIET_MS = Number(process.env.YAPSUM_CANARY_QUIET_MS || 15000);
const FETCH_MS = Number(process.env.YAPSUM_CANARY_FETCH_MS || 20000);

const report = new Report("canary-mweb", { video: VIDEO, surface: "mweb" });

const CONTENT = `
  const CC_SEL = ${JSON.stringify(contractSelectors("mweb-cc-"))};
  const SUB_SEL = ${JSON.stringify(contractFor("mweb-subscribe-anchor").expr)};
  const LIKE_SEL = ${JSON.stringify(contractFor("mweb-like-anchor").expr)};
  const ACTION_BAR = ${JSON.stringify(contractFor("mweb-slim-action-bar").expr)};
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const player = () => document.querySelector("#movie_player");
  const api = () => { const p = player(); return p && (p.wrappedJSObject || p); };
  const ccBtn = () => document.querySelector(CC_SEL);

  onCmd("facts", () => {
    const a = api();
    const b = ccBtn();
    const v = document.querySelector("video");
    return {
      hasMoviePlayer: !!player(),
      unwrapWorks: !!(player() && player().wrappedJSObject),
      hasToggleSubtitles: !!(a && typeof a.toggleSubtitles === "function"),
      hasIsSubtitlesOn: !!(a && typeof a.isSubtitlesOn === "function"),
      isSubtitlesOn: safe(() => a.isSubtitlesOn(), "throw"),
      isSubtitlesOnType: safe(() => typeof a.isSubtitlesOn(), null),
      tracklistLen: safe(() => (a.getOption("captions", "tracklist") || []).length, null),
      ccPresent: !!b,
      ccPressed: b ? b.getAttribute("aria-pressed") : null,
      ccClass: b ? String(b.className).slice(0, 60) : null,
      subscribeAnchor: !!document.querySelector(SUB_SEL),
      likeAnchor: !!document.querySelector(LIKE_SEL),
      actionBar: !!document.querySelector(ACTION_BAR),
      actionBarTags: safe(() => {
        const bar = document.querySelector(ACTION_BAR);
        if (!bar) return null;
        return [...new Set([...bar.querySelectorAll("*")].map((e) => e.tagName.toLowerCase()).filter((t) => t.includes("-")))].slice(0, 14);
      }, null),
      likeCandidates: safe(() => [...document.querySelectorAll("button[aria-label]")]
        .filter((b) => /^like\\b|dislike/i.test(b.getAttribute("aria-label") || ""))
        .slice(0, 3)
        .map((b) => ({ tag: b.tagName.toLowerCase(), parent: b.parentElement ? b.parentElement.tagName.toLowerCase() : null, label: (b.getAttribute("aria-label") || "").slice(0, 24) })), null),
      paused: v ? v.paused : null,
      ct: v ? Math.round(v.currentTime * 10) / 10 : null,
      videoPresent: !!v,
    };
  });

  onCmd("toggle", () => {
    const a = api();
    const before = safe(() => a.isSubtitlesOn(), null);
    if (a && typeof a.toggleSubtitles === "function") {
      safe(() => a.toggleSubtitles());
      return { via: "api", before, after: safe(() => a.isSubtitlesOn(), null) };
    }
    const b = ccBtn();
    if (b) { b.click(); return { via: "button", before, after: null }; }
    return { err: "no caption control" };
  });

  onCmd("ensureOff", () => {
    const a = api();
    for (let i = 0; i < 4; i++) {
      const on = safe(() => a.isSubtitlesOn(), null);
      if (on === false) return { ok: true, iters: i };
      safe(() => a.toggleSubtitles());
    }
    return { ok: safe(() => a.isSubtitlesOn(), null) === false };
  });
`;

const h = createHarness({ target: "android", site: "mweb", bare: true, observe: ["timedtext"], content: CONTENT });
const facts = () => h.call("facts", null, { match: VIDEO, timeoutMs: 10000 });

try {
  report.infra("emulator", () => android.ensureEmulator());
  report.infra("mobile-ua", () => android.setDesktopUa(false));
  android.dismissDialogs();

  await h.start();
  await h.open(VIDEO);

  const ready = await h.waitFor(async () => {
    const f = await facts();
    return f && f.videoPresent ? f : null;
  }, 90000, "watch page");
  if (!ready) throw new Error("INFRA: watch page never reported a video element");

  report.check("movie-player-element-id", ready.hasMoviePlayer, { found: ready.hasMoviePlayer });
  report.check("wrapped-js-object-unwrap", ready.unwrapWorks, { note: "content scripts need wrappedJSObject to reach page APIs" });
  report.check("toggle-subtitles-api", ready.hasToggleSubtitles, {});
  report.check("mweb-is-subtitles-on-truthful", ready.hasIsSubtitlesOn && ready.isSubtitlesOnType === "boolean", {
    present: ready.hasIsSubtitlesOn,
    type: ready.isSubtitlesOnType,
    valueBeforePlayback: ready.isSubtitlesOn,
  });
  report.check("mweb-controls-render-on-interaction", ready.ccPresent === false, {
    note: "CC button is expected ABSENT before any player interaction; if it is present, the API-first path is no longer load-bearing",
    ccPresent: ready.ccPresent,
  });

  let playing = null;
  for (let i = 0; i < 7 && !playing; i++) {
    android.tapPlay(i);
    await sleep(4000);
    const f = await facts();
    if (f && f.paused === false && f.ct > 0.4) playing = f;
  }
  if (!playing) throw new Error("INFRA: could not start playback with a real tap");
  report.note("playback", { ct: playing.ct });

  const off = await h.call("ensureOff", null, { match: VIDEO, timeoutMs: 25000 });
  report.note("ensureOff", off);
  if (!off || !off.ok) throw new Error("INFRA: could not force captions off before the quiet window");

  await h.open(VIDEO);
  await sleep(6000);
  const coldReady = await h.waitFor(async () => {
    const f = await facts();
    return f && f.videoPresent && f.isSubtitlesOn === false ? f : null;
  }, 60000, "cold reload with captions off");
  if (!coldReady) throw new Error("INFRA: cold reload never settled with captions off");
  let coldPlaying = null;
  for (let i = 0; i < 7 && !coldPlaying; i++) {
    android.tapPlay(i);
    await sleep(4000);
    const f = await facts();
    if (f && f.paused === false && f.ct > 0.4) coldPlaying = f;
  }
  if (!coldPlaying) throw new Error("INFRA: could not start playback on the cold reload");
  report.note("cold-playback", { ct: coldPlaying.ct, capsOn: coldPlaying.isSubtitlesOn });

  const quietMark = h.mark();
  await sleep(QUIET_MS);
  const quiet = h.since("net-request", quietMark).filter((e) => e.v === VIDEO);
  report.check("mweb-caption-fetch-requires-display", quiet.length === 0, {
    windowMs: QUIET_MS,
    requestsSeen: quiet.length,
    note: quiet.length ? "player now fetches captions with display OFF; the caption kick may be unnecessary" : null,
  });

  const afterQuiet = await facts();
  report.check("mweb-toggle-subtitles-needs-module", afterQuiet.tracklistLen !== null, {
    tracklistLen: afterQuiet.tracklistLen,
    note: "tracklist readability is how the extension knows a toggle will not be a silent no-op",
  });

  const fetchMark = h.mark();
  let toggled = null;
  for (let i = 0; i < 5; i++) {
    toggled = await h.call("toggle", null, { match: VIDEO, timeoutMs: 15000 });
    if (toggled && toggled.after === true) break;
    await sleep(3000);
  }
  report.note("toggle", toggled);
  report.check("toggle-subtitles-enables-captions", !!(toggled && toggled.after === true), {
    result: toggled,
    note: "toggleSubtitles must eventually flip isSubtitlesOn to true; it silently no-ops before the captions module loads",
  });

  await h.waitFor(() => h.since("net-request", fetchMark).some((e) => e.v === VIDEO), FETCH_MS, "caption fetch");
  await sleep(2500);
  const reqs = h.since("net-request", fetchMark).filter((e) => e.v === VIDEO);
  const bodies = h.since("net-body", fetchMark).filter((e) => e.v === VIDEO);

  report.check("mweb-caption-fetch-on-display", reqs.length > 0, { requests: reqs.length, windowMs: FETCH_MS });
  report.check("timedtext-potoken-signed", reqs.some((r) => r.pot === true), { pots: reqs.map((r) => r.pot) });
  report.check("timedtext-json3-format", reqs.some((r) => r.fmt === "json3"), { fmts: reqs.map((r) => r.fmt) });
  report.check("tt-json3-events-array", bodies.some((b) => b.segs > 0), {
    bodies: bodies.map((b) => ({ bytes: b.bytes, segs: b.segs, parseErr: b.parseErr })),
  });
  report.check("accept-encoding-identity", bodies.every((b) => !b.parseErr), {
    note: "an unparseable body usually means the response arrived compressed",
    parseErrors: bodies.map((b) => b.parseErr).filter(Boolean),
  });
  report.check("tt-videoid-v-param", reqs.every((r) => r.v === VIDEO), { seen: [...new Set(reqs.map((r) => r.v))] });

  const post = await facts();
  report.check("mweb-cc-button-class", post.ccPresent, { cls: post.ccClass, note: "expected present once controls have rendered" });
  report.check("mweb-cc-aria-pressed", post.ccPressed === "true" || post.ccPressed === "false", { value: post.ccPressed });
  report.check("mweb-subscribe-anchor", post.subscribeAnchor, {});
  report.check("mweb-like-anchor", post.likeAnchor, {
    actionBarTags: post.actionBarTags,
    likeCandidates: post.likeCandidates,
    note: "if this fails, the tags above show what the action bar renders now",
  });
  report.check("mweb-slim-action-bar", post.actionBar, {});

  await h.call("ensureOff", null, { match: VIDEO, timeoutMs: 20000 });
  h.screenshot("canary-mweb-final");
} catch (e) {
  report.fatal(e);
} finally {
  await h.stop();
}

process.exit(report.finish());
