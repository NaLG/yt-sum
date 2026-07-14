#!/usr/bin/env node
// Probe: does running Summarize on a m.youtube.com SHORT desync the player's
// tap-to-pause? Field report (2026-07-11, store v0.5.x on a real phone): after
// summarizing a short, center-tap stopped toggling play/pause until a reload.
// Suspect: kickMobilePlayback/restoreMobilePlayback pausing+rewinding a video
// the shorts UI didn't know we touched. That path only runs when the short was
// PAUSED at Summarize time (an already-playing short is left alone), so both
// scenarios are driven here, with REAL OS-level taps (adb input tap), not
// synthetic events.
//
// Runs the CURRENT source with shortsButton=true (the opt-in rail button),
// verifying the mobile shorts experience end to end: round button in the
// action rail, extraction via playback capture, and tap health afterward.
// (2026-07-11: the original store-behavior run found NO desync in either
// scenario, and captions-intercept extracted 23 lines on both.)
//
//   node test/probe-shorts-desync.mjs [SHORTS_VIDEO_ID]   # emulator must be up
//
// Sequence (all on https://m.youtube.com/shorts/<id>, mobile UA required):
//   A. baseline: tap toggles pause/resume
//   S1. summarize while PLAYING (kick/restore no-op) -> close panel -> tap test
//   S2. pause via tap, summarize while PAUSED (kick+restore run) -> close -> tap test
// Exit 0 = all tap tests pass (no desync reproduced). Non-zero = reproduced or
// harness failure; read the timeline dump.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const SRC = new URL("../src", import.meta.url).pathname;
const ARTIFACTS = new URL("./artifacts", import.meta.url).pathname;
const FIREFOX_APK = process.env.YAPSUM_FIREFOX_APK || "org.mozilla.firefox";
const VIDEO = process.argv[2] || "eCS01HnPdSs"; // has an ASR caption track (checked 2026-07-11)
const SHORTS_URL = `https://m.youtube.com/shorts/${VIDEO}`;
const DEBUG = process.env.YAPSUM_DEBUG === "1";
const adb = (...a) => execFileSync("adb", a, { encoding: "utf8" });

// ---- device ------------------------------------------------------------------
const DEVICE = adb("devices").split("\n").slice(1)
  .map((l) => l.trim().split(/\s+/)).find(([, s]) => s === "device")?.[0];
if (!DEVICE) { console.error("no adb device (run scripts/android-emulator.sh up)"); process.exit(1); }
const [SW, SH] = (adb("shell", "wm", "size").match(/(\d+)x(\d+)/) || []).slice(1).map(Number);
if (!SW) { console.error("couldn't read screen size"); process.exit(1); }
// Center-ish tap point: inside the video, above any bottom sheet, below chrome.
const TAP_X = Math.round(SW / 2), TAP_Y = Math.round(SH * 0.4);
console.log(`device ${DEVICE}, screen ${SW}x${SH}, tap point ${TAP_X},${TAP_Y}`);

// The provisioning script sets a DESKTOP UA override (for extraction tests).
// This probe needs the real mobile experience; strip it (idempotent, and
// `android-emulator.sh up` re-adds it when the extraction tests next need it).
// Also allow autoplay: a real phone autoplays shorts, the fresh test profile
// blocks them, and the whole play/pause tap surface behaves differently on a
// never-started video.
try {
  adb("root"); await new Promise((r) => setTimeout(r, 1500));
  const prof = adb("shell", "ls -d /data/data/org.mozilla.firefox/files/mozilla/*.default").trim();
  adb("shell", `sed -i '/general.useragent.override/d' ${prof}/user.js 2>/dev/null || true`);
  adb("shell", `grep -q media.autoplay.default ${prof}/user.js 2>/dev/null || printf '%s\\n%s\\n' 'user_pref("media.autoplay.default", 0);' 'user_pref("media.autoplay.blocking_policy", 0);' >> ${prof}/user.js`);
  adb("shell", "am force-stop org.mozilla.firefox");
  console.log("mobile UA restored, autoplay allowed, Firefox stopped");
} catch (e) { console.log(`profile prep skipped: ${String(e).slice(0, 120)}`); }

// ---- relay server --------------------------------------------------------------
let latest = null;                 // newest state snapshot from the page
const cmdQueue = [];               // node -> reporter commands
let acked = new Set();
const server = createServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (req.method === "GET" && req.url === "/cmd") {
    const next = cmdQueue[0] || null;
    return res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify(next || {}));
  }
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.writeHead(204, cors).end();
    try {
      const m = JSON.parse(b);
      if (req.url === "/state") latest = { ...m, rxAt: Date.now() };
      else if (req.url === "/ack") { if (cmdQueue[0]?.id === m.id) cmdQueue.shift(); acked.add(m.id); }
      else if (req.url === "/shot" && m.dataUrl) {
        mkdirSync(ARTIFACTS, { recursive: true });
        writeFileSync(join(ARTIFACTS, m.name || "shorts-desync.png"), Buffer.from(m.dataUrl.split(",")[1], "base64"));
      }
    } catch {}
  });
});
const PORT = await new Promise((r) => server.listen(0, "0.0.0.0", () => r(server.address().port)));
adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`);

// ---- temp extension: real src, shorts guards patched out, + probe scripts ----
const ext = mkdtempSync(join(tmpdir(), "yapsum-desync-"));
cpSync(SRC, ext, { recursive: true });

const mf = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
mf.permissions.push("http://127.0.0.1/*", "<all_urls>");
mf.content_scripts[0].js.push("probe-reporter.js");
mf.background.scripts.push("probe-bg.js");
writeFileSync(join(ext, "manifest.json"), JSON.stringify(mf));

writeFileSync(
  join(ext, "probe-bg.js"),
  `browser.storage.local.set({ shortsButton: true }); // opt in to the rail button
   browser.runtime.onMessage.addListener(async (m) => {
     if (!m || !m.__probe) return;
     if (m.kind === "summarize") {
       const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
       if (tab) browser.tabs.sendMessage(tab.id, { type: "yapsum-summarize" }).catch(() => {});
     } else if (m.kind === "shot") {
       const dataUrl = await browser.tabs.captureVisibleTab(null, { format: "png" }).catch(() => null);
       if (dataUrl) fetch("http://127.0.0.1:${PORT}/shot", { method: "POST",
         headers: { "content-type": "application/json" },
         body: JSON.stringify({ dataUrl, name: m.name }) }).catch(() => {});
     }
   });`
);

writeFileSync(
  join(ext, "probe-reporter.js"),
  `(() => {
     if (!location.pathname.startsWith("/shorts/")) return;
     const post = (path, body) => fetch("http://127.0.0.1:${PORT}" + path, {
       method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
     }).catch(() => {});
     // Record what input actually reaches the page, so "tap not delivered" and
     // "tap delivered but ignored" are distinguishable from the harness.
     const events = [];
     for (const type of ["pointerdown", "touchstart", "mousedown", "click"]) {
       window.addEventListener(type, (e) => {
         events.push({ type, t: Date.now(), trusted: e.isTrusted,
           x: Math.round(e.clientX), y: Math.round(e.clientY),
           target: (e.target.tagName || "?").toLowerCase() +
                   (e.target.className && typeof e.target.className === "string" ? "." + e.target.className.split(" ")[0] : "") });
         if (events.length > 8) events.shift();
       }, true);
     }
     // The reel scroller keeps neighbor/preload <video> elements around; "the"
     // video is the one actually covering the viewport (largest intersection).
     const activeVideo = () => {
       let best = null, bestArea = 0;
       for (const cand of document.querySelectorAll("video")) {
         const r = cand.getBoundingClientRect();
         const ix = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.x, 0));
         const iy = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.y, 0));
         if (ix * iy > bestArea) { bestArea = ix * iy; best = cand; }
       }
       // Before first playback some variants park the (only) player element
       // off-viewport and show a poster image instead; fall back to it.
       return best || document.querySelector("video");
     };
     let lastPlayErr = null, hitCount = 0, lastHit = null, lastSynthTarget = null;
     const snap = () => {
       const v = activeVideo();
       const panel = document.getElementById("yapsum-panel");
       const btn = document.getElementById("yapsum-btn");
       const pr = panel ? panel.getBoundingClientRect() : null;
       const br = btn ? btn.getBoundingClientRect() : null;
       const vr = v ? v.getBoundingClientRect() : null;
       const dpr = devicePixelRatio;
       return {
         t: Date.now(), url: location.href,
         scriptActive: document.documentElement.dataset.yapsum === "loaded",
         method: document.documentElement.dataset.yapsumMethod || null,
         video: v ? { paused: v.paused, ct: Math.round(v.currentTime * 10) / 10, muted: v.muted,
                      offscreen: vr.bottom <= 0 || vr.top >= innerHeight,
                      // physical-screen tap point centered on the video element
                      tapX: Math.round((mozInnerScreenX + vr.x + vr.width / 2) * dpr),
                      tapY: Math.round((mozInnerScreenY + vr.y + vr.height * 0.45) * dpr) } : null,
         reelUi: !!document.querySelector("reel-action-bar-view-model, ytd-reel-video-renderer, ytd-shorts, ytm-shorts, [class*='reel']"),
         panel: panel ? { text: (panel.querySelector(".yapsum-panel-body")?.textContent || "").slice(0, 80),
                          top: Math.round(pr.top), h: Math.round(pr.height) } : null,
         btn: btn ? { parent: btn.parentElement?.tagName.toLowerCase(), cls: btn.className,
                      x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) } : null,
         events: events.slice(-5),
         playErr: lastPlayErr, hitCount, lastHit, lastSynthTarget,
         hitEl: (() => { try { const e = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight * 0.35)); return e ? (e.tagName || "?").toLowerCase() + (e.id ? "#" + e.id : "") + (e.className && typeof e.className === "string" ? "." + e.className.split(" ")[0] : "") : null; } catch { return null; } })(),
         videoCount: document.querySelectorAll("video").length,
         vh: innerHeight, vw: innerWidth,
       };
     };
     setInterval(() => { if (document.visibilityState === "visible") post("/state", snap()); }, 300);
     setInterval(async () => {
       if (document.visibilityState !== "visible") return;
       let cmd = null;
       try { cmd = await (await fetch("http://127.0.0.1:${PORT}/cmd")).json(); } catch {}
       if (!cmd || !cmd.id || cmd.done) return;
       if (cmd.kind === "summarize") browser.runtime.sendMessage({ __probe: true, kind: "summarize" }).catch(() => {});
       else if (cmd.kind === "closepanel") document.getElementById("yapsum-panel")?.remove();
       else if (cmd.kind === "shot") browser.runtime.sendMessage({ __probe: true, kind: "shot", name: cmd.name }).catch(() => {});
       else if (cmd.kind === "play" || cmd.kind === "mutedplay") {
         try {
           const v = activeVideo();
           if (v && cmd.kind === "mutedplay") v.muted = true;
           v?.play()?.then(() => { lastPlayErr = "none (played)"; }, (e) => { lastPlayErr = String(e); });
         } catch (e) { lastPlayErr = String(e); }
       }
       else if (cmd.kind === "synthtap") {
         // Synthetic tap: when paused, prefer YouTube's own visible Play
         // button (background taps while controls are up mean "hide controls",
         // not "resume"); otherwise event-sequence at the reel center.
         const x = Math.round(innerWidth / 2), y = Math.round(innerHeight * 0.35);
         let el = null;
         const v = activeVideo();
         if (v && v.paused) {
           for (const b of document.querySelectorAll('button[aria-label], [role="button"][aria-label]')) {
             const r = b.getBoundingClientRect();
             if (/^(play|reproducir)\b/i.test(b.getAttribute("aria-label") || "") && r.width > 0 && r.top >= 0 && r.bottom <= innerHeight) { el = b; break; }
           }
         }
         el = el || document.elementFromPoint(x, y) || document.body;
         lastSynthTarget = (el.tagName || "?").toLowerCase() + "[" + (el.getAttribute && el.getAttribute("aria-label") || "") + "]";
         const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
         try {
           el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 9, pointerType: "touch", isPrimary: true }));
           el.dispatchEvent(new MouseEvent("mousedown", opts));
           el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 9, pointerType: "touch", isPrimary: true }));
           el.dispatchEvent(new MouseEvent("mouseup", opts));
           el.dispatchEvent(new MouseEvent("click", opts));
         } catch (e) { lastPlayErr = "synthtap: " + String(e); }
       }
       else if (cmd.kind === "hittest") {
         const ov = document.createElement("div");
         ov.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:transparent";
         ov.addEventListener("pointerdown", (e) => { hitCount++; lastHit = { x: Math.round(e.clientX), y: Math.round(e.clientY) }; }, true);
         document.documentElement.appendChild(ov);
         setTimeout(() => ov.remove(), 6000);
       }
       await post("/ack", { id: cmd.id });
     }, 400);
   })();`
);

// ---- launch web-ext on the emulator -------------------------------------------
const child = spawn("web-ext", [
  "run", "--source-dir", ext, "--target", "firefox-android",
  "--android-device", DEVICE, "--firefox-apk", FIREFOX_APK,
], { stdio: ["ignore", "pipe", "pipe"] });
let installed = false;
const onLog = (d) => {
  if (DEBUG) process.stdout.write(d);
  if (/Installed .*temporary add-on/.test(String(d)) && !installed) {
    installed = true;
    setTimeout(() => {
      try { adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", SHORTS_URL, FIREFOX_APK); } catch {}
    }, 3000);
  }
};
child.stdout.on("data", onLog);
child.stderr.on("data", onLog);

// ---- orchestration helpers -----------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cmdSeq = 0;
async function sendCmd(kind, extra = {}) {
  const id = `c${++cmdSeq}`;
  cmdQueue.push({ id, kind, ...extra });
  for (let i = 0; i < 50 && !acked.has(id); i++) await sleep(300);
  if (!acked.has(id)) throw new Error(`cmd ${kind} never acked`);
}
async function waitState(pred, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (latest && Date.now() - latest.rxAt < 2500 && pred(latest)) return latest;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${label} (latest: ${JSON.stringify(latest)?.slice(0, 300)})`);
}
// Tap the video element's own center (physical coords computed in-page via
// mozInnerScreen*), falling back to the blind screen-center point.
const tap = () => {
  const vt = latest?.video;
  const inBounds = vt && vt.tapX > 0 && vt.tapX < SW && vt.tapY > 0 && vt.tapY < SH;
  const p = inBounds ? [vt.tapX, vt.tapY] : [TAP_X, TAP_Y];
  // `input tap` is swallowed while a web-ext RDP session is attached (verified
  // empirically on the emulator); a 1px 60ms swipe delivers as a tap always.
  adb("shell", "input", "swipe", String(p[0]), String(p[1]), String(p[0] + 1), String(p[1] + 1), "60");
  return p;
};
const timeline = [];
const note = (m, x) => { timeline.push({ at: new Date().toISOString().slice(11, 19), m, ...(x || {}) }); console.log(`  ${m}`, x ? JSON.stringify(x) : ""); };

// The testable direction: a synthetic tap on the reel PAUSES a playing video
// (verified at baseline). Resume is attempted via YouTube's own Play button,
// but an untrusted tap may be ignored there; playback is restored with muted
// play() so the next test starts from a known state.
async function tapPauseTest(name) {
  let st = await waitState((s) => s.video, 10000, "video present");
  if (st.video.paused) {
    await sendCmd("mutedplay");
    await waitState((s) => s.video && !s.video.paused, 8000, `playing for ${name}`);
    await sleep(800);
  }
  await sendCmd("synthtap");
  let paused = null;
  try { paused = await waitState((s) => s.video?.paused === true, 4000, "pause flip"); } catch {}
  if (!paused) {
    note(`${name}: FAIL, tap did not pause`, { hitEl: latest?.hitEl, target: latest?.lastSynthTarget });
    return { ok: false, detail: "tap->pause dead", hitEl: latest?.hitEl };
  }
  await sleep(700);
  await sendCmd("synthtap");
  let resumed = null;
  try { resumed = await waitState((s) => s.video?.paused === false, 4000, "resume flip"); } catch {}
  note(`${name}: tap->pause OK${resumed ? ", tap->resume OK" : " (resume tap ignored; synthetic-event limitation)"}`, { target: latest?.lastSynthTarget });
  return { ok: true, resumeByTap: !!resumed };
}

// ---- run -----------------------------------------------------------------------
const results = {};
try {
  console.log("waiting for the shorts page + content script...");
  await waitState((s) => s.scriptActive && s.video && s.reelUi !== false, 120000, "shorts page live");
  note("page live", { url: latest.url, video: latest.video, btn: latest.btn });
  if (!/m\.youtube\.com\/shorts\//.test(latest.url)) throw new Error(`bounced off mobile shorts: ${latest.url}`);
  adb("shell", "input", "swipe", "540", "50", "541", "51", "60"); // warm-up input on the inert status bar
  await sleep(1000);
  await sleep(3000); // let autoplay settle
  note("settled", { video: latest.video, btn: latest.btn });
  await sendCmd("shot", { name: "desync-baseline.png" });

  // Playback first: mutedplay mimics the extension's own kickMobilePlayback
  // (autoplay is blocked in the test profile; a real phone's short autoplays).
  if (latest.video?.paused) {
    await sendCmd("mutedplay");
    await waitState((s) => s.video && !s.video.paused, 8000, "playing after muted play()");
    note("muted play started playback", { playErr: latest.playErr, hitEl: latest.hitEl });
    await sleep(1500);
  }

  // A. baseline tap-to-pause
  results.baseline = await tapPauseTest("A baseline");
  if (!results.baseline.ok) throw new Error("INCONCLUSIVE: synthetic taps don't pause even at baseline; hitEl=" + (latest?.hitEl || "?"));

  // S1. summarize while PLAYING (kick/restore should be a no-op)
  if (latest.video?.paused) { await sendCmd("mutedplay"); await waitState((s) => !s.video?.paused, 8000, "playing before S1"); }
  note("S1: summarize while playing");
  await sendCmd("summarize");
  const s1done = await waitState(
    (s) => s.method || /Transcript ready|Summarizing|Summary failed|Couldn't get/.test(s.panel?.text || ""),
    80000, "S1 extraction settled");
  results.s1extract = { method: s1done.method, panel: s1done.panel?.text };
  note("S1 extraction settled", results.s1extract);
  await sendCmd("shot", { name: "desync-s1-panel.png" });
  await sendCmd("closepanel");
  await sleep(1000);
  results.s1tap = await tapPauseTest("S1 after summarize(playing)");

  // S2. summarize while PAUSED (kick mutes+plays, restore pauses+rewinds)
  const cur = await waitState((s) => s.video, 5000, "video");
  if (!cur.video.paused) { await sendCmd("synthtap"); await waitState((s) => s.video?.paused, 5000, "paused for S2"); }
  note("S2: summarize while paused", { video: latest.video });
  await sendCmd("summarize");
  const s2done = await waitState(
    (s) => /Transcript ready|Summarizing|Summary failed|Couldn't get/.test(s.panel?.text || ""),
    80000, "S2 extraction settled");
  results.s2extract = { method: s2done.method, panel: s2done.panel?.text };
  note("S2 extraction settled", results.s2extract);
  await sleep(2000); // restoreMobilePlayback runs in the finally; let it land
  note("S2 post-restore video state", { video: latest.video });
  await sendCmd("shot", { name: "desync-s2-panel.png" });
  await sendCmd("closepanel");
  await sleep(1000);
  results.s2tap = await tapPauseTest("S2 after summarize(paused)");
} catch (e) {
  results.harnessError = String(e.message || e);
  note("HARNESS ERROR", { err: results.harnessError });
}

try { child.kill("SIGTERM"); } catch {}
server.close();

// ---- verdict --------------------------------------------------------------------
console.log("\n== timeline ==");
for (const e of timeline) console.log(`${e.at} ${e.m} ${JSON.stringify({ ...e, at: undefined, m: undefined })}`);
console.log("\n== results ==");
console.log(JSON.stringify(results, null, 2));
const bad = results.harnessError || !results.baseline?.ok || !results.s1tap?.ok || !results.s2tap?.ok;
console.log(bad ? "\n❌ desync reproduced or probe failed, see above" : "\n✅ no tap-to-pause desync reproduced (both scenarios)");
process.exit(bad ? 1 : 0);
