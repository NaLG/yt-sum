#!/usr/bin/env node
// Placement smoke test: asserts the Summarize button sits ON THE SAME ROW as
// the Subscribe control, TO ITS RIGHT, at content width (not stretched), and
// that all three button styles (text / tldw / icon) render and live-swap via
// storage.onChanged. Runs the REAL extension in a real Firefox (web-ext, not
// WebDriver) with a reporter content script relaying facts over localhost.
//
//   node test/smoke-placement.mjs                          # desktop watch page
//   node test/smoke-placement.mjs --target firefox-android # emulator/device (adb reverse)
//
// Exit 0 when every assertion passes.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const SRC = new URL("../src", import.meta.url).pathname;
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const FIREFOX_APK = process.env.YAPSUM_FIREFOX_APK || "org.mozilla.firefox";
const rawArgs = process.argv.slice(2);
const ti = rawArgs.indexOf("--target");
const ANDROID = ti !== -1 && rawArgs[ti + 1] === "firefox-android";
const positional = rawArgs.filter((a, i) => a !== "--target" && (ti === -1 || i !== ti + 1));
const VIDEO = positional[0] || "eIho2S0ZahI";
const WATCH_URL = ANDROID
  ? `https://m.youtube.com/watch?v=${VIDEO}`
  : `https://www.youtube.com/watch?v=${VIDEO}`;
const DEBUG = process.env.YAPSUM_DEBUG === "1";

// ---- relay server -----------------------------------------------------------
let resolveReport = null;
const server = createServer((req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, cors()).end();
  if (req.method === "POST" && req.url === "/report") {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.writeHead(204, cors()).end();
      try { resolveReport?.(JSON.parse(b)); } catch { resolveReport?.({ error: "bad body" }); }
    });
    return;
  }
  res.writeHead(404, cors()).end();
});
const cors = () => ({ "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
const PORT = await new Promise((r) => server.listen(0, ANDROID ? "0.0.0.0" : "127.0.0.1", () => r(server.address().port)));
const DEVICE = ANDROID
  ? execFileSync("adb", ["devices"], { encoding: "utf8" }).split("\n").slice(1)
      .map((l) => l.trim().split(/\s+/)).find(([, s]) => s === "device")?.[0]
  : null;
if (ANDROID && !DEVICE) { console.error("no adb device"); process.exit(1); }
if (ANDROID) execFileSync("adb", ["reverse", `tcp:${PORT}`, `tcp:${PORT}`]);

// ---- temp extension = real src + reporter -----------------------------------
const ext = mkdtempSync(join(tmpdir(), "yapsum-place-"));
cpSync(SRC, ext, { recursive: true });
const mf = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
mf.permissions.push("http://127.0.0.1/*");
mf.content_scripts[0].js.push("place-reporter.js"); // runs after content.js
mf.background.scripts.push("place-bg.js");
writeFileSync(join(ext, "manifest.json"), JSON.stringify(mf));
writeFileSync(
  join(ext, "place-bg.js"),
  `browser.runtime.onMessage.addListener((m) => { if (m && m.__place) fetch("http://127.0.0.1:${PORT}/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) }).catch(() => {}); });`
);
writeFileSync(
  join(ext, "place-reporter.js"),
  `(async () => {
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     const facts = () => {
       const b = document.getElementById("yapsum-btn");
       if (!b) return null;
       const next = b.nextElementSibling;
       const br = b.getBoundingClientRect();
       const nr = next ? next.getBoundingClientRect() : null;
       const nextAria = next
         ? (next.matches && next.matches("button[aria-label]")
             ? next.getAttribute("aria-label")
             : next.querySelector && next.querySelector("button[aria-label]")
               ? next.querySelector("button[aria-label]").getAttribute("aria-label")
               : null)
         : null;
       return {
         parent: b.parentElement ? (b.parentElement.id || b.parentElement.tagName.toLowerCase()) : null,
         next: next ? (next.id || next.tagName.toLowerCase()) : null,
         nextAria: (nextAria || "").slice(0, 28),
         rowKids: b.parentElement ? [...b.parentElement.children].map((c) => c.tagName.toLowerCase()).slice(0, 12) : [],
         text: (b.textContent || "").trim(),
         cls: b.className,
         hasImg: !!b.querySelector("img"),
         w: Math.round(br.width),
         visible: br.width > 0 && br.height > 0,
         sameRow: nr ? br.top < nr.bottom && nr.top < br.bottom : null,
         leftOfNext: nr ? br.right <= nr.left + 2 : null,
       };
     };
     const waitFor = async (pred, tries) => {
       for (let i = 0; i < (tries || 60); i++) { const f = facts(); if (f && pred(f)) return f; await sleep(500); }
       return facts();
     };
     const results = {};
     // Reset explicitly: a retried navigation can inherit storage state a
     // killed prior reporter instance left mid-sequence.
     await browser.storage.local.set({ buttonStyle: "text" });
     results.text = await waitFor((f) => f.visible && /summ?arize|^sum$/i.test(f.text), 80);
     await browser.storage.local.set({ buttonStyle: "sum" });
     results.sum = await waitFor((f) => /^sum$/i.test(f.text), 20);
     await browser.storage.local.set({ buttonStyle: "tldw" });
     results.tldw = await waitFor((f) => /TL;DW/i.test(f.text), 20);
     await browser.storage.local.set({ buttonStyle: "icon" });
     results.icon = await waitFor((f) => f.hasImg, 20);
     await browser.storage.local.set({ buttonStyle: "text" });
     browser.runtime.sendMessage({ __place: true, results, host: location.hostname });
   })();`
);

// ---- launch ------------------------------------------------------------------
const webExtArgs = ANDROID
  ? ["run", "--source-dir", ext, "--target", "firefox-android", "--android-device", DEVICE, "--firefox-apk", FIREFOX_APK]
  : ["run", "--source-dir", ext, "--firefox", FIREFOX,
     "--firefox-profile", mkdtempSync(join(tmpdir(), "yapsum-ffp-")), "--profile-create-if-missing",
     "--start-url", WATCH_URL, "--no-reload", "--no-input"];
const child = spawn("web-ext", webExtArgs, { stdio: ["ignore", "pipe", "pipe"] });

// Android has no --start-url, and content scripts only attach to pages loaded
// AFTER the temp add-on installs: navigate by intent only once web-ext says
// "Installed", and retry once if the first page load produced no report.
let gotReport = false;
if (ANDROID) {
  const fire = () => {
    try { execFileSync("adb", ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", WATCH_URL, FIREFOX_APK]); } catch {}
  };
  // web-ext logs may land on stdout OR stderr depending on version: watch both.
  const onLog = (d) => {
    if (DEBUG) process.stdout.write(d);
    if (/Installed .*temporary add-on/.test(String(d))) {
      setTimeout(fire, 3000);
      setTimeout(() => { if (!gotReport) fire(); }, 50000);
    }
  };
  child.stdout.on("data", onLog);
  child.stderr.on("data", onLog);
} else if (DEBUG) {
  child.stdout.on("data", (d) => process.stdout.write(d));
  child.stderr.on("data", (d) => process.stderr.write(d));
}

const report = await new Promise((resolve) => {
  resolveReport = (r) => { gotReport = true; resolve(r); };
  setTimeout(() => resolve({ error: `timeout (${ANDROID ? 180 : 90}s)` }), ANDROID ? 180000 : 90000);
});
try { child.kill("SIGTERM"); } catch {}
server.close();

// ---- assertions --------------------------------------------------------------
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};
if (report.error || !report.results) {
  console.log(`✗ no report: ${report.error || JSON.stringify(report)}`);
  process.exit(1);
}
const { results } = report;
const fmt = (f) => f ? `parent=${f.parent} next=${f.next} nextAria="${f.nextAria}" w=${f.w} sameRow=${f.sameRow} leftOfNext=${f.leftOfNext}` : "null";
console.log(`page: ${report.host}`);
console.log(`row:  [${(results.text?.rowKids || []).join(", ")}]`);
console.log(`text: ${fmt(results.text)}`);
console.log(`sum:  ${fmt(results.sum)}`);
console.log(`tldw: ${fmt(results.tldw)}`);
console.log(`icon: ${fmt(results.icon)}${results.icon ? ` hasImg=${results.icon.hasImg}` : ""}`);

const likeish = (f) => /like|segmented/i.test(f?.next || "") || /^like\b/i.test(f?.nextAria || "");
const t = results.text;
check("text style rendered", !!t && /summ?arize|^sum$/i.test(t.text), t ? `text="${t.text}"` : "");
check("button visible", !!t?.visible);
check("next control is the like button", likeish(t), t ? `next=${t.next}` : "");
check("same row as the like control", t?.sameRow === true);
check("immediately left of the like control", t?.leftOfNext === true);
check("content width, not stretched", (t?.w || 999) < 170, `w=${t?.w}`);
const s = results.sum;
check("sum style live-swapped", !!s && /^sum$/i.test(s.text), s ? `w=${s.w}` : "");
check("sum stays left of like, same row", s?.sameRow === true && s?.leftOfNext === true);
const d = results.tldw;
check("tldw style live-swapped", !!d && /TL;DW/i.test(d.text), d ? `w=${d.w}` : "");
check("tldw stays left of like, same row", d?.sameRow === true && d?.leftOfNext === true);
const ic = results.icon;
check("icon style live-swapped", ic?.hasImg === true, ic ? `w=${ic.w}` : "");
check("icon is compact", (ic?.w || 999) <= 44, `w=${ic?.w}`);
check("icon stays left of like, same row", ic?.sameRow === true && ic?.leftOfNext === true);

console.log(failures ? `\n❌ ${failures} placement check(s) failed` : "\n✅ placement OK");
process.exit(failures ? 1 : 0);
