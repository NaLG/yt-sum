#!/usr/bin/env node
// Shorts button smoke test. Default is OFF: no button on /shorts/ (caption
// coverage there is spotty; extraction itself works via playback capture when
// captions exist, see test/probe-shorts-desync.mjs). The shortsButton setting
// opts in to a round logo button in the shorts action rail.
//
// Deterministic checks, real extension in a real Firefox (web-ext):
//   1. content script IS active on the shorts page (absence isn't vacuous)
//   2. the page really rendered the shorts/reel UI
//   3. default (toggle off): no #yapsum-btn appears in a 12s watch window
//   4. a planted decoy #yapsum-btn is removed by ensureButton's shorts guard
//      (exercises the SPA-navigation cleanup branch)
//   5. shortsButton=true: a round logo button appears (img, circle-sized)
//   6. shortsButton=false again: the button is removed
// A viewport screenshot is saved to test/artifacts/shorts.png as a rendering
// artifact for release review (advisory only, never a gate).
//
//   node test/smoke-shorts.mjs [SHORTS_VIDEO_ID]
//
// Exit 0 when every assertion passes.

import { spawn } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const SRC = new URL("../src", import.meta.url).pathname;
const ARTIFACTS = new URL("./artifacts", import.meta.url).pathname;
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const VIDEO = process.argv[2] || "eCS01HnPdSs";
const SHORTS_URL = `https://www.youtube.com/shorts/${VIDEO}`;
const DEBUG = process.env.YAPSUM_DEBUG === "1";

// ---- relay server -----------------------------------------------------------
let resolveReport = null;
const server = createServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.writeHead(204, cors).end();
    try {
      const m = JSON.parse(b);
      if (req.url === "/shot" && m.dataUrl) {
        mkdirSync(ARTIFACTS, { recursive: true });
        writeFileSync(join(ARTIFACTS, "shorts.png"), Buffer.from(m.dataUrl.split(",")[1], "base64"));
      } else if (req.url === "/report") {
        resolveReport?.(m);
      }
    } catch { resolveReport?.({ error: "bad body" }); }
  });
});
const PORT = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

// ---- temp extension = real src + reporter -----------------------------------
const ext = mkdtempSync(join(tmpdir(), "yapsum-shorts-"));
cpSync(SRC, ext, { recursive: true });
const mf = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
mf.permissions.push("http://127.0.0.1/*", "<all_urls>"); // captureVisibleTab needs <all_urls>
mf.content_scripts[0].js.push("shorts-reporter.js"); // runs after content.js
mf.background.scripts.push("shorts-bg.js");
writeFileSync(join(ext, "manifest.json"), JSON.stringify(mf));

writeFileSync(
  join(ext, "shorts-bg.js"),
  `browser.runtime.onMessage.addListener(async (m) => {
     if (!m || !m.__shorts) return;
     const post = (path, body) => fetch("http://127.0.0.1:${PORT}" + path, {
       method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
     }).catch(() => {});
     if (m.kind === "shot") {
       const dataUrl = await browser.tabs.captureVisibleTab(null, { format: "png" }).catch(() => null);
       if (dataUrl) await post("/shot", { dataUrl });
       return;
     }
     if (m.kind === "report") await post("/report", m.report);
   });`
);

writeFileSync(
  join(ext, "shorts-reporter.js"),
  `(async () => {
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     if (!location.pathname.startsWith("/shorts/")) return;
     const report = { url: location.href };
     // Belt and braces: a previous (killed) run may have left the toggle on.
     await browser.storage.local.set({ shortsButton: false });
     // 1+2: content script active, shorts UI actually rendered (wait for both).
     for (let i = 0; i < 60; i++) {
       report.scriptActive = document.documentElement.dataset.yapsum === "loaded";
       report.reelUi = !!document.querySelector(
         "reel-action-bar-view-model, ytd-reel-video-renderer, ytd-shorts");
       if (report.scriptActive && report.reelUi) break;
       await sleep(500);
     }
     // 3: observe 12s; with the toggle off the button must never show up.
     report.buttonSeen = false;
     for (let i = 0; i < 24; i++) {
       if (document.getElementById("yapsum-btn")) { report.buttonSeen = true; break; }
       await sleep(500);
     }
     // 4: plant a decoy; ensureButton's shorts guard must remove it.
     const decoy = document.createElement("div");
     decoy.id = "yapsum-btn";
     document.body.appendChild(decoy);
     report.decoyRemoved = false;
     for (let i = 0; i < 10; i++) {
       if (!document.getElementById("yapsum-btn")) { report.decoyRemoved = true; break; }
       await sleep(500);
     }
     // 5: opt in -> the round logo button appears in the rail.
     await browser.storage.local.set({ shortsButton: true });
     report.optIn = null;
     for (let i = 0; i < 30; i++) {
       const b = document.getElementById("yapsum-btn");
       if (b) {
         const r = b.getBoundingClientRect();
         report.optIn = {
           cls: b.className,
           hasImg: !!b.querySelector("img"),
           w: Math.round(r.width), h: Math.round(r.height),
           visible: r.width > 0 && r.height > 0,
           parent: b.parentElement ? (b.parentElement.tagName || "").toLowerCase() : null,
         };
         if (report.optIn.visible) break;
       }
       await sleep(500);
     }
     // Rendering artifact with the opt-in button up (best-effort).
     await browser.runtime.sendMessage({ __shorts: true, kind: "shot" }).catch(() => {});
     // 6: opt back out -> the button is removed.
     await browser.storage.local.set({ shortsButton: false });
     report.optOutRemoved = false;
     for (let i = 0; i < 10; i++) {
       if (!document.getElementById("yapsum-btn")) { report.optOutRemoved = true; break; }
       await sleep(500);
     }
     browser.runtime.sendMessage({ __shorts: true, kind: "report", report }).catch(() => {});
   })();`
);

// ---- launch ------------------------------------------------------------------
const child = spawn("web-ext", [
  "run", "--source-dir", ext, "--firefox", FIREFOX,
  "--firefox-profile", mkdtempSync(join(tmpdir(), "yapsum-ffp-")), "--profile-create-if-missing",
  "--start-url", SHORTS_URL, "--no-reload", "--no-input",
  // Headed Firefox can't start while the macOS session is locked (WindowServer
  // denies it and web-ext dies on ECONNREFUSED); headless renders fine and
  // Firefox's headless UA is identical, so YouTube behaves the same.
  ...(process.env.YAPSUM_HEADLESS === "1" ? ["--arg=-headless"] : []),
], { stdio: ["ignore", "pipe", "pipe"] });
if (DEBUG) {
  child.stdout.on("data", (d) => process.stdout.write(d));
  child.stderr.on("data", (d) => process.stderr.write(d));
}

const report = await new Promise((resolve) => {
  resolveReport = resolve;
  setTimeout(() => resolve({ error: "timeout (120s)" }), 120000);
});
try { child.kill("SIGTERM"); } catch {}
server.close();

// ---- assertions --------------------------------------------------------------
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};
if (report.error) {
  console.log(`✗ no report: ${report.error}`);
  process.exit(1);
}
console.log(`page: ${report.url}`);
check("content script active on shorts page", report.scriptActive === true);
check("shorts/reel UI rendered", report.reelUi === true);
check("default off: no button injected (12s watch)", report.buttonSeen === false);
check("decoy #yapsum-btn removed by shorts guard", report.decoyRemoved === true);
const oi = report.optIn;
check("opt-in: button appears", !!oi && oi.visible === true, oi ? `parent=${oi.parent}` : "");
check("opt-in: round logo variant", !!oi && oi.hasImg === true && /yapsum-btn-shorts/.test(oi.cls || ""));
check("opt-in: circle-sized for the rail", !!oi && oi.w >= 36 && oi.w <= 56 && Math.abs(oi.w - oi.h) <= 2, oi ? `${oi.w}x${oi.h}` : "");
check("opt-out: button removed again", report.optOutRemoved === true);

console.log(failures ? `\n❌ ${failures} shorts check(s) failed` : "\n✅ shorts button behavior OK");
process.exit(failures ? 1 : 0);
