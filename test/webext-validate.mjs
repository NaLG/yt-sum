#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const EXTRACTOR = new URL("../src/content/extractor.js", import.meta.url).pathname;
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const FIREFOX_APK = process.env.YAPSUM_FIREFOX_APK || "org.mozilla.firefox";
const DEBUG = process.env.YAPSUM_DEBUG === "1";

const rawArgs = process.argv.slice(2);
const ti = rawArgs.indexOf("--target");
const ANDROID = ti !== -1 && rawArgs[ti + 1] === "firefox-android";
const targets = rawArgs.filter((a, i) => a !== "--target" && (ti === -1 || i !== ti + 1));
const videoIds = targets.length ? targets : ["eIho2S0ZahI", "-FOCpMAww28"];
const DESKTOP_UA = process.env.YAPSUM_DESKTOP_UA === "1";

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
      try {
        const parsed = JSON.parse(body);
        if (parsed.ping) {
          if (DEBUG) console.log(`  [ping] ${JSON.stringify(parsed)}`);
        } else {
          resolveReport?.(parsed);
        }
      } catch { resolveReport?.({ ok: false, error: "bad report body" }); }
    });
    return;
  }
  res.writeHead(404, cors()).end();
});
const cors = () => ({ "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
const PORT = await new Promise((r) => server.listen(0, ANDROID ? "0.0.0.0" : "127.0.0.1", () => r(server.address().port)));
if (ANDROID) {
  try {
    execFileSync("adb", ["reverse", `tcp:${PORT}`, `tcp:${PORT}`]);
    console.log(`adb reverse tcp:${PORT} → Mac:${PORT} set up`);
  } catch (e) {
    console.error("adb reverse failed; is a device connected? " + e.message);
    process.exit(1);
  }
}

const extDir = mkdtempSync(join(tmpdir(), "yapsum-testext-"));
mkdirSync(join(extDir, "content"), { recursive: true });
copyFileSync(EXTRACTOR, join(extDir, "content", "extractor.js"));

writeFileSync(
  join(extDir, "manifest.json"),
  JSON.stringify({
    manifest_version: 2,
    name: "yap-sum extraction test",
    version: "0.0.0",
    browser_specific_settings: { gecko: { id: "yapsum-test@nalg.dev" } },
    permissions: ["webRequest", "webRequestBlocking", "https://www.youtube.com/*", "https://m.youtube.com/*", "http://127.0.0.1/*"],
    background: { scripts: ["bg.js"], persistent: true },
    content_scripts: [
      {
        matches: ["https://www.youtube.com/watch*", "https://m.youtube.com/watch*"],
        js: ["content/extractor.js", "reporter.js"],
        run_at: "document_idle",
      },
    ],
  })
);

writeFileSync(
  join(extDir, "bg.js"),
  `const report = (msg) =>
     fetch("http://127.0.0.1:${PORT}/report", {
       method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg),
     }).catch(() => {});
   browser.runtime.onMessage.addListener((msg) => { report(msg); });
   let uaRewriteOk = null, uaHits = 0;
   ${DESKTOP_UA ? `
   try {
     browser.webRequest.onBeforeSendHeaders.addListener(
       (d) => {
         uaHits++;
         for (const h of d.requestHeaders) {
           if (h.name.toLowerCase() === "user-agent") h.value = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0";
         }
         return { requestHeaders: d.requestHeaders };
       },
       { urls: ["https://www.youtube.com/*", "https://m.youtube.com/*"] },
       ["blocking", "requestHeaders"]
     );
     uaRewriteOk = true;
   } catch (e) { uaRewriteOk = String(e); }
   setInterval(() => report({ ping: true, from: "bg", uaRewriteOk, uaHits }), 5000);
   ` : ""}
   report({
     ping: true, from: "bg", loaded: true, uaRewriteOk,
     apis: Object.keys(browser).sort().join(","),
     manifestPerms: (browser.runtime.getManifest().permissions || []).join(","),
   });
   browser.permissions?.getAll?.().then((p) => report({ ping: true, from: "bg", granted: JSON.stringify(p) }));`
);

writeFileSync(
  join(extDir, "reporter.js"),
  `(async () => {
     const started = Date.now();
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     const diag = { webdriver: navigator.webdriver };
     browser.runtime.sendMessage({ ping: true, from: "content", href: location.href.slice(0, 90) });
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
       // Post-mortem: is the panel there but undetected, or truly empty?
       try { diag.panelInfo = globalThis.yapSum.transcriptPanelInfo(); } catch (x) { diag.panelInfo = String(x); }
       try {
         diag.panels = Array.from(document.querySelectorAll("[target-id]")).map((p) => ({
           t: p.getAttribute("target-id"),
           vis: p.getAttribute("visibility") || (p.offsetParent ? "vis" : "hidden"),
           kids: p.querySelectorAll("*").length,
           head: (p.innerText || "").replace(/\\s+/g, " ").slice(0, 80),
         }));
         const b = globalThis.yapSum.findTranscriptButton?.();
         diag.button = b ? { tag: b.tagName.toLowerCase(), aria: b.getAttribute("aria-label"), text: (b.textContent || "").trim().slice(0, 40) } : null;
       } catch (x) { diag.panels = String(x); }
       try {
         let n = 0;
         for (const el of document.querySelectorAll("*")) {
           if (el.children.length === 0 && /^\\d{1,2}:\\d{2}(?::\\d{2})?$/.test((el.textContent || "").trim())) n++;
         }
         diag.globalTsRows = n;
       } catch {}
       browser.runtime.sendMessage({ ok: false, error: String(e), errors: e.errors, wallMs: Date.now() - started, diag });
     }
   })();`
);

function androidDevice() {
  const out = execFileSync("adb", ["devices"], { encoding: "utf8" });
  const ids = out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter(([, s]) => s === "device").map(([id]) => id);
  if (!ids.length) throw new Error("no authorized Android device (see scripts/run-android.mjs for setup)");
  return ids[0];
}

function webExtArgs(videoId, profileDir) {
  const common = ["run", "--source-dir", extDir, "--no-reload", "--no-input"];
  if (ANDROID) {
    return [...common, "--target", "firefox-android", "--android-device", androidDevice(), "--firefox-apk", FIREFOX_APK];
  }
  return [
    ...common,
    "--start-url", `https://www.youtube.com/watch?v=${videoId}`,
    "--firefox", FIREFOX, "--firefox-profile", profileDir, "--profile-create-if-missing", "--pref", "app.update.disabledForTesting=true",
    ...(process.env.YAPSUM_HEADLESS === "1" ? ["--arg=-headless"] : []),
  ];
}

function runOne(videoId) {
  const TIMEOUT_MS = ANDROID ? 150000 : 75000;
  return new Promise((resolve) => {
    let done = false;
    const profileDir = mkdtempSync(join(tmpdir(), "yapsum-ff-"));
    const child = spawn("web-ext", webExtArgs(videoId, profileDir), {
      stdio: ["ignore", "pipe", DEBUG ? "inherit" : "ignore"],
    });
    let stdoutBuf = "";
    child.stdout.on("data", (chunk) => {
      if (DEBUG) process.stdout.write(chunk);
      if (!ANDROID || stdoutBuf === null) return;
      stdoutBuf += chunk;
      if (/Installed .* as a temporary add-on/.test(stdoutBuf)) {
        stdoutBuf = null;
        try {
          execFileSync("adb", [
            "shell", "am", "start", "-a", "android.intent.action.VIEW",
            "-d", `https://www.youtube.com/watch?v=${videoId}`, FIREFOX_APK,
          ]);
          if (DEBUG) console.log(`\n[validate] sent VIEW intent for ${videoId}`);
        } catch (e) {
          finish({ videoId, ok: false, error: "adb VIEW intent failed: " + e.message });
        }
      }
    });
    const finish = (result) => {
      if (done) return;
      done = true;
      resolveReport = null;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500);
      try { execFileSync("/bin/sh", ["-c", `sleep 2; pkill -f 'firefox.*-profile ${tmpdir()}'; true`]); } catch {}
      resolve(result);
    };
    resolveReport = (report) => finish({ videoId, ...report });
    child.on("error", (e) => finish({ videoId, ok: false, error: "web-ext spawn error: " + e.message }));
    setTimeout(() => finish({ videoId, ok: false, error: `timeout waiting for report (${TIMEOUT_MS / 1000}s)` }), TIMEOUT_MS);
  });
}

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
