#!/usr/bin/env node
// Smoke test the REAL extension UI under real Firefox (web-ext, not WebDriver —
// which YouTube blocks). Copies src/ to a temp dir, adds one extra reporter
// content script that runs alongside the real content.js and reports (over a
// localhost relay) whether the Summarize button was injected into the shared DOM.

import { spawn } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const SRC = new URL("../src", import.meta.url).pathname;
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const VIDEO = process.argv[2] || "eIho2S0ZahI";
const DEBUG = process.env.YAPSUM_DEBUG === "1";

// relay server
let resolveReport = null;
const server = createServer((req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, cors()).end();
  if (req.method === "POST" && req.url === "/report") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.writeHead(204, cors()).end(); try { resolveReport?.(JSON.parse(b)); } catch { resolveReport?.({ ok: false }); } });
    return;
  }
  res.writeHead(404, cors()).end();
});
const cors = () => ({ "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
const PORT = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

// build temp ext = real src + reporter
const ext = mkdtempSync(join(tmpdir(), "yapsum-smoke-"));
cpSync(SRC, ext, { recursive: true });
const mf = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
mf.permissions.push("http://127.0.0.1/*");
mf.content_scripts[0].js.push("smoke-reporter.js"); // runs after content.js
mf.background = mf.background || { scripts: [], persistent: false };
mf.background.scripts.push("smoke-bg.js");
writeFileSync(join(ext, "manifest.json"), JSON.stringify(mf));
writeFileSync(
  join(ext, "smoke-bg.js"),
  `browser.runtime.onMessage.addListener((m) => { if (m && m.__smoke) fetch("http://127.0.0.1:${PORT}/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) }).catch(() => {}); });`
);
writeFileSync(
  join(ext, "smoke-reporter.js"),
  `(async () => {
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     let btn = false, active = false;
     for (let i = 0; i < 40; i++) {
       await sleep(500);
       active = document.documentElement.dataset.yapsum === "loaded";
       btn = !!document.getElementById("yapsum-btn");
       if (btn) break;
     }
     const b = document.getElementById("yapsum-btn");
     browser.runtime.sendMessage({ __smoke: true, ok: btn, active,
       btnText: b && b.textContent, hostTag: b && b.parentElement && b.parentElement.tagName.toLowerCase() });
   })();`
);

const profileDir = mkdtempSync(join(tmpdir(), "yapsum-ff-"));
const child = spawn("web-ext", [
  "run", "--source-dir", ext, "--firefox", FIREFOX, "--firefox-profile", profileDir,
  "--profile-create-if-missing", "--start-url", `https://www.youtube.com/watch?v=${VIDEO}`, "--no-reload", "--no-input",
  // Headed Firefox can't start while the macOS session is locked; headless
  // renders identically (same UA) and keeps the suite runnable unattended.
  ...(process.env.YAPSUM_HEADLESS === "1" ? ["--arg=-headless"] : []),
], { stdio: DEBUG ? ["ignore", "inherit", "inherit"] : "ignore" });

const report = await new Promise((resolve) => {
  resolveReport = resolve;
  setTimeout(() => resolve({ ok: false, error: "timeout (60s)" }), 60000);
});
try { child.kill("SIGTERM"); } catch {}
server.close();

console.log("content script active:", report.active);
if (report.ok) {
  console.log(`✓ Summarize button injected — text="${report.btnText}" host=<${report.hostTag}>`);
} else {
  console.log(`✗ button not injected ${report.error ? "(" + report.error + ")" : ""} (active=${report.active})`);
}
process.exit(report.ok ? 0 : 1);
