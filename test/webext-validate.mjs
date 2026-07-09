#!/usr/bin/env node
// Non-WebDriver validation of the extraction pathway — the authoritative test.
//
// Why: WebDriver/marionette-automated Firefox is detected by YouTube; its
// get_transcript/timedtext preconditions fail (every automated variant in
// test/*.mjs returns 400 failedPrecondition — even YouTube's OWN panel call).
// `web-ext run` launches a NORMAL Firefox (no marionette webdriver flag) — the
// extension's real environment.
//
// How: a throwaway test extension runs the REAL src/content/extractor.js on the
// watch page, then relays the result through its background script (not subject
// to YouTube's page CSP) to a localhost HTTP server this harness runs.
//
// Usage: node test/webext-validate.mjs [VIDEO_ID ...]
// Exit 0 if every video extracted a transcript; 1 otherwise.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const EXTRACTOR = new URL("../src/content/extractor.js", import.meta.url).pathname;
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const DEBUG = process.env.YAPSUM_DEBUG === "1";

// --target firefox-android runs the SAME test on a USB-connected phone.
// `adb reverse` tunnels the phone's 127.0.0.1:PORT to this Mac's relay server,
// so the extension's localhost report reaches us unchanged.
const rawArgs = process.argv.slice(2);
const ti = rawArgs.indexOf("--target");
const ANDROID = ti !== -1 && rawArgs[ti + 1] === "firefox-android";
const targets = rawArgs.filter((a, i) => a !== "--target" && i !== ti + 1);
const videoIds = targets.length ? targets : ["eIho2S0ZahI", "-FOCpMAww28"];

// ---- localhost report server ------------------------------------------------

let resolveReport = null;
const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors()).end();
    return;
  }
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(204, cors()).end();
      try { resolveReport?.(JSON.parse(body)); } catch { resolveReport?.({ ok: false, error: "bad report body" }); }
    });
    return;
  }
  res.writeHead(404, cors()).end();
});
const cors = () => ({ "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
// Bind to all interfaces on Android so `adb reverse` can tunnel to it.
const PORT = await new Promise((r) => server.listen(0, ANDROID ? "0.0.0.0" : "127.0.0.1", () => r(server.address().port)));
if (ANDROID) {
  try {
    execFileSync("adb", ["reverse", `tcp:${PORT}`, `tcp:${PORT}`]);
    console.log(`adb reverse tcp:${PORT} → Mac:${PORT} set up`);
  } catch (e) {
    console.error("adb reverse failed — is a device connected? " + e.message);
    process.exit(1);
  }
}

// ---- build throwaway test extension ----------------------------------------

const extDir = mkdtempSync(join(tmpdir(), "yapsum-testext-"));
mkdirSync(join(extDir, "content"), { recursive: true });
copyFileSync(EXTRACTOR, join(extDir, "content", "extractor.js")); // the REAL extractor

writeFileSync(
  join(extDir, "manifest.json"),
  JSON.stringify({
    manifest_version: 2,
    name: "yap-sum extraction test",
    version: "0.0.0",
    browser_specific_settings: { gecko: { id: "yapsum-test@nalg.dev" } },
    permissions: ["https://www.youtube.com/*", "https://m.youtube.com/*", "http://127.0.0.1/*"],
    background: { scripts: ["bg.js"], persistent: false },
    content_scripts: [
      {
        matches: ["https://www.youtube.com/watch*", "https://m.youtube.com/watch*"],
        js: ["content/extractor.js", "reporter.js"],
        run_at: "document_idle",
      },
    ],
  })
);

// Background relays the content-script result to localhost (content scripts
// can't reach localhost under YouTube's CSP; background isn't CSP-bound).
writeFileSync(
  join(extDir, "bg.js"),
  `browser.runtime.onMessage.addListener((msg) => {
     fetch("http://127.0.0.1:${PORT}/report", {
       method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg),
     }).catch(() => {});
   });`
);

// Reporter: wait for the page to settle, run the real extractor, send result up.
writeFileSync(
  join(extDir, "reporter.js"),
  `(async () => {
     const started = Date.now();
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     const diag = { webdriver: navigator.webdriver };
     // let the SPA settle so the transcript button / player data are present
     for (let i = 0; i < 20; i++) {
       if (new URLSearchParams(location.search).get("v")) break;
       await sleep(500);
     }
     await sleep(1500);
     try {
       const r = await globalThis.yapSum.extractTranscript();
       browser.runtime.sendMessage({
         ok: true, videoId: r.videoId, method: r.method, segments: r.segments.length,
         chars: r.chars, timings: r.timings, fallbackErrors: r.errors, wallMs: Date.now() - started,
         first: r.segments[0] && r.segments[0].text.slice(0, 60), diag,
       });
     } catch (e) {
       browser.runtime.sendMessage({ ok: false, error: String(e), errors: e.errors, wallMs: Date.now() - started, diag });
     }
   })();`
);

// ---- run one video ----------------------------------------------------------

function androidDevice() {
  const out = execFileSync("adb", ["devices"], { encoding: "utf8" });
  const ids = out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter(([, s]) => s === "device").map(([id]) => id);
  if (!ids.length) throw new Error("no authorized Android device (see scripts/run-android.mjs for setup)");
  return ids[0];
}

function webExtArgs(videoId, profileDir) {
  const common = [
    "run",
    "--source-dir", extDir,
    "--start-url", `https://www.youtube.com/watch?v=${videoId}`,
    "--no-reload",
    "--no-input",
  ];
  if (ANDROID) {
    return [...common, "--target", "firefox-android", "--android-device", androidDevice(), "--firefox-apk", process.env.YAPSUM_FIREFOX_APK || "org.mozilla.firefox"];
  }
  return [...common, "--firefox", FIREFOX, "--firefox-profile", profileDir, "--profile-create-if-missing"];
}

function runOne(videoId) {
  return new Promise((resolve) => {
    let done = false;
    const profileDir = mkdtempSync(join(tmpdir(), "yapsum-ff-"));
    const child = spawn("web-ext", webExtArgs(videoId, profileDir), {
      stdio: DEBUG ? ["ignore", "inherit", "inherit"] : "ignore",
    });
    const finish = (result) => {
      if (done) return;
      done = true;
      resolveReport = null;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500);
      resolve(result);
    };
    resolveReport = (report) => finish({ videoId, ...report });
    child.on("error", (e) => finish({ videoId, ok: false, error: "web-ext spawn error: " + e.message }));
    setTimeout(() => finish({ videoId, ok: false, error: "timeout waiting for report (75s)" }), 75000);
  });
}

// ---- main -------------------------------------------------------------------

console.log(`Validating extraction via web-ext (${ANDROID ? "Firefox for Android" : "desktop Firefox"}, port ${PORT}) on ${videoIds.length} video(s)...\n`);
let allOk = true;
for (const id of videoIds) {
  const r = await runOne(id);
  if (r.ok) {
    console.log(
      `✓ ${id}  method=${r.method}  segments=${r.segments}  chars=${(r.chars || 0).toLocaleString()}  ` +
        `wall=${r.wallMs}ms  timings=${JSON.stringify(r.timings)}`
    );
    if (r.fallbackErrors?.length) console.log(`    earlier attempts: ${r.fallbackErrors.join(" | ")}`);
    if (r.first) console.log(`    first line: "${r.first}"`);
  } else {
    allOk = false;
    console.log(`✗ ${id}  FAILED: ${r.error}`);
    if (r.errors) console.log(`    ${r.errors.join(" | ")}`);
  }
  if (r.diag) console.log(`    diag: ${JSON.stringify(r.diag)}`);
}
server.close();
console.log(allOk ? "\n✅ All videos extracted OK in real Firefox." : "\n❌ Some videos failed.");
process.exit(allOk ? 0 : 1);
