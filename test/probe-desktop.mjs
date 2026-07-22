#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const videoId = process.argv[2] || "31MvP7yHzxM";

let resolveReport = null;
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(204).end();
      try {
        const msg = JSON.parse(body);
        if (msg.ping) console.log("  [tick]", JSON.stringify(msg.tick));
        else resolveReport?.(msg);
      } catch { resolveReport?.({ error: "bad body" }); }
    });
    return;
  }
  res.writeHead(404).end();
});
const PORT = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

const extDir = mkdtempSync(join(tmpdir(), "yapsum-dprobe-"));
mkdirSync(extDir, { recursive: true });
writeFileSync(
  join(extDir, "manifest.json"),
  JSON.stringify({
    manifest_version: 2,
    name: "yap-sum desktop probe",
    version: "0.0.0",
    browser_specific_settings: { gecko: { id: "yapsum-dprobe@nalg.dev" } },
    permissions: ["webRequest", "webRequestBlocking", "https://www.youtube.com/*", "http://127.0.0.1/*"],
    background: { scripts: ["bg.js"], persistent: true },
    content_scripts: [{ matches: ["https://www.youtube.com/watch*"], js: ["probe.js"], run_at: "document_idle" }],
  })
);
writeFileSync(
  join(extDir, "bg.js"),
  `// Watch ALL youtubei traffic; capture get_transcript bodies like the real
   // extension's intercept does (filterResponseData).
   const reqLog = [];
   const tail = (u) => u.replace(/^https?:\\/\\/[^/]+/, "").slice(0, 90);
   browser.webRequest.onBeforeRequest.addListener(
     (d) => {
       reqLog.push({ t: Date.now(), ev: "start", url: tail(d.url), type: d.type });
       if (/get_transcript|get_panel|timedtext/.test(d.url)) {
         const filter = browser.webRequest.filterResponseData(d.requestId);
         const chunks = [];
         filter.ondata = (e) => { chunks.push(new Uint8Array(e.data)); filter.write(e.data); };
         filter.onstop = () => {
           filter.close();
           try {
             let len = 0; for (const c of chunks) len += c.length;
             const buf = new Uint8Array(len); let o = 0;
             for (const c of chunks) { buf.set(c, o); o += c.length; }
             const text = new TextDecoder().decode(buf);
             reqLog.push({ t: Date.now(), ev: "body", url: tail(d.url), len: text.length,
                           segs: text.split("transcriptSegmentRenderer").length - 1,
                           head: text.slice(0, 150) });
           } catch (e) { reqLog.push({ ev: "bodyErr", err: String(e) }); }
         };
       }
     },
     { urls: ["https://www.youtube.com/youtubei/*", "https://www.youtube.com/api/timedtext*"] },
     ["blocking"]
   );
   browser.webRequest.onCompleted.addListener(
     (d) => reqLog.push({ ev: "done", url: tail(d.url), status: d.statusCode }),
     { urls: ["https://www.youtube.com/youtubei/*", "https://www.youtube.com/api/timedtext*"] }
   );
   browser.webRequest.onErrorOccurred.addListener(
     (d) => reqLog.push({ ev: "err", url: tail(d.url), error: d.error }),
     { urls: ["https://www.youtube.com/youtubei/*", "https://www.youtube.com/api/timedtext*"] }
   );
   browser.runtime.onMessage.addListener((msg) => {
     if (!msg.ping) msg.reqLog = reqLog;
     fetch("http://127.0.0.1:${PORT}/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) }).catch(() => {});
   });`
);
writeFileSync(
  join(extDir, "probe.js"),
  `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 30; i++) { if (document.querySelector("video")) break; await sleep(500); }
    await sleep(2500);

    const snap = () => {
      const modern = document.querySelector('[target-id="PAmodern_transcript_view"]');
      const classic = document.querySelector('[target-id="engagement-panel-searchable-transcript"]');
      const info = (p) => p ? {
        vis: p.getAttribute("visibility"), kids: p.querySelectorAll("*").length,
        textLen: (p.innerText || "").length,
      } : null;
      let rows = 0;
      for (const el of document.querySelectorAll("*")) {
        if (el.children.length === 0 && /^\\d{1,2}:\\d{2}(?::\\d{2})?$/.test((el.textContent || "").trim())) rows++;
      }
      const v = document.querySelector("video");
      return { modern: info(modern), classic: info(classic), rows, paused: v ? v.paused : null,
               segAnchors: (Array.from(document.scripts, (s) => s.text || "").join("") + "").split("transcriptSegmentRenderer").length - 1 };
    };

    const out = { href: location.href, timeline: [] };
    const tick = (label) => { const t = { t: Date.now(), label, ...snap() }; out.timeline.push(t); browser.runtime.sendMessage({ ping: true, tick: t }); };

    tick("initial");
    // Which PANEL interaction triggers the 760KB timedtext fetch on PAmodern?
    const expand = document.querySelector("#description #expand, #expand");
    if (expand) { expand.click(); await sleep(800); }
    const btn = document.querySelector('button[aria-label*="transcript" i]') ||
      Array.from(document.querySelectorAll("button, [role=button]")).find((x) => /transcript/i.test(x.getAttribute("aria-label") || ""));
    if (!btn) { out.noButton = true; browser.runtime.sendMessage(out); return; }
    btn.click();
    tick("panel-opened");
    for (let i = 1; i <= 6; i++) { await sleep(2000); tick("open" + 2 * i + "s"); }

    try { document.querySelector('[target-id="PAmodern_transcript_view"]').scrollIntoView(); } catch {}
    tick("scrolled");
    for (let i = 1; i <= 3; i++) { await sleep(2000); tick("scroll" + 2 * i + "s"); }

    btn.click(); await sleep(1000); tick("toggled-off");
    btn.click(); tick("toggled-on");
    for (let i = 1; i <= 6; i++) { await sleep(2000); tick("retoggle" + 2 * i + "s"); }
    browser.runtime.sendMessage(out);
  })();`
);

const profileDir = mkdtempSync(join(tmpdir(), "yapsum-dprobe-ff-"));
const child = spawn(
  "web-ext",
  ["run", "--source-dir", extDir, "--no-reload", "--no-input",
   "--start-url", `https://www.youtube.com/watch?v=${videoId}`,
   "--firefox", FIREFOX, "--firefox-profile", profileDir, "--profile-create-if-missing"],
  { stdio: "ignore" }
);

const report = await new Promise((resolve) => {
  resolveReport = resolve;
  setTimeout(() => resolve({ error: "timeout (150s)" }), 150000);
});
try { child.kill("SIGTERM"); } catch {}
setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500);
console.log(JSON.stringify(report, null, 2));
server.close();
process.exit(report.error ? 1 : 0);
