#!/usr/bin/env node
// Validate the mobile Tier-1 fix hypothesis: on m.youtube.com the player does
// NOT fetch the transcript/caption track until playback starts. This probe
// loads on the real mobile site (Firefox Nightly, which grants webRequest to
// temp installs), watches get_transcript + timedtext network requests, and:
//   1. waits paused, records whether any transcript fetch fired (expect: no)
//   2. calls video.play() MUTED, records whether one fires now (expect: yes)
//   3. pauses + restores.
// If a fetch appears only after play(), the playback-nudge fix is correct.
//
// Usage: . scripts/android-env.sh && node test/probe-mobile-playback.mjs [VIDEO_ID]

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const FIREFOX_APK = process.env.YAPSUM_FIREFOX_APK || "org.mozilla.fenix"; // Nightly
const videoId = process.argv[2] || "eIho2S0ZahI";

let resolveReport = null;
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { res.writeHead(204).end(); try { resolveReport?.(JSON.parse(body)); } catch { resolveReport?.({ error: "bad body" }); } });
    return;
  }
  res.writeHead(404).end();
});
const PORT = await new Promise((r) => server.listen(0, "0.0.0.0", () => r(server.address().port)));
execFileSync("adb", ["reverse", `tcp:${PORT}`, `tcp:${PORT}`]);

const extDir = mkdtempSync(join(tmpdir(), "yapsum-pbprobe-"));
mkdirSync(extDir, { recursive: true });
writeFileSync(
  join(extDir, "manifest.json"),
  JSON.stringify({
    manifest_version: 2,
    name: "yap-sum playback probe",
    version: "0.0.0",
    browser_specific_settings: { gecko: { id: "yapsum-pbprobe@nalg.dev" } },
    permissions: ["webRequest", "webRequestBlocking", "https://www.youtube.com/*", "https://m.youtube.com/*", "http://127.0.0.1/*"],
    background: { scripts: ["bg.js"], persistent: true },
    content_scripts: [{ matches: ["https://m.youtube.com/watch*", "https://www.youtube.com/watch*"], js: ["probe.js"], run_at: "document_idle" }],
  })
);
// Background: log transcript-bearing requests with timestamps; answer "fired since T?"
writeFileSync(
  join(extDir, "bg.js"),
  `const hits = [];
   const note = (url) => hits.push({ t: Date.now(), kind: /get_transcript/.test(url) ? "get_transcript" : "timedtext",
     v: (url.match(/[?&]v=([\\w-]{11})/) || [])[1] || null });
   browser.webRequest.onBeforeRequest.addListener(
     (d) => note(d.url),
     { urls: ["*://*.youtube.com/youtubei/v1/get_transcript*", "*://*.youtube.com/api/timedtext*"] }
   );
   browser.runtime.onMessage.addListener((msg, sender, send) => {
     if (msg.q === "since") { send({ hits: hits.filter((h) => h.t >= msg.t) }); return true; }
     if (msg.report) fetch("http://127.0.0.1:${PORT}/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg.report) }).catch(() => {});
   });`
);
// Content: paused baseline → play muted → restore; ask bg what fired in each window.
writeFileSync(
  join(extDir, "probe.js"),
  `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const since = (t) => browser.runtime.sendMessage({ q: "since", t });
    const out = { href: location.href };
    let v = null;
    for (let i = 0; i < 40; i++) { v = document.querySelector("video"); if (v) break; await sleep(500); }
    if (!v) { browser.runtime.sendMessage({ report: { ...out, error: "no video element" } }); return; }

    // Baseline: stay paused ~6s, see if any transcript fetch fires on its own.
    const tStart = Date.now();
    out.startedPaused = v.paused;
    await sleep(6000);
    out.pausedWindow = (await since(tStart)).hits;

    // Trigger: play muted.
    const wasMuted = v.muted, pos = v.currentTime;
    const tPlay = Date.now();
    try { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { out.playErr = String(e); }
    await sleep(2000);
    out.playingAfter = !v.paused;
    for (let i = 0; i < 20; i++) { await sleep(500); if ((await since(tPlay)).hits.length) break; }
    out.playWindow = (await since(tPlay)).hits;

    // Restore.
    try { if (out.startedPaused) { v.pause(); v.currentTime = pos; } v.muted = wasMuted; } catch {}
    out.restoredPaused = v.paused;
    browser.runtime.sendMessage({ report: out });
  })();`
);

const device = (() => {
  const o = execFileSync("adb", ["devices"], { encoding: "utf8" });
  return o.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter(([, s]) => s === "device").map(([id]) => id)[0];
})();
const child = spawn("web-ext", ["run", "--source-dir", extDir, "--no-reload", "--no-input", "--target", "firefox-android", "--android-device", device, "--firefox-apk", FIREFOX_APK], { stdio: ["ignore", "pipe", "ignore"] });
let buf = "";
child.stdout.on("data", (c) => {
  buf += c;
  if (/Installed .* as a temporary add-on/.test(buf)) {
    buf = "";
    execFileSync("adb", ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `https://m.youtube.com/watch?v=${videoId}`, FIREFOX_APK]);
    console.log("navigated to m.youtube.com; probing…");
  }
});
const report = await new Promise((resolve) => { resolveReport = resolve; setTimeout(() => resolve({ error: "timeout (120s)" }), 120000); });
try { child.kill("SIGTERM"); } catch {}
console.log(JSON.stringify(report, null, 2));
const paused = (report.pausedWindow || []).length, played = (report.playWindow || []).length;
if (!report.error) {
  console.log(`\nBaseline (paused ${6}s): ${paused} transcript fetch(es). After play(): ${played}.`);
  console.log(paused === 0 && played > 0
    ? "✅ CONFIRMED: transcript fetch fires only after playback — the playback-nudge fix is correct."
    : paused > 0
      ? "ℹ️ transcript fetched while paused too — nudge still harmless, but cold Summarize should already work here."
      : "❌ no transcript fetch even after play — this video needs the desktop/iframe fallback.");
}
server.close();
process.exit(report.error ? 1 : 0);
