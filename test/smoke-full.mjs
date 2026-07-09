#!/usr/bin/env node
// Full-path verification in real Firefox (web-ext):
//   Summarize click -> extractor -> background -> HTTP POST -> SSE stream parse
//   -> panel render.
//
// A local mock speaks the real OpenAI /v1/chat/completions streaming protocol.
// It validates the request the background actually sent (system+user messages,
// stream:true) and echoes back proof the REAL transcript flowed through
// (transcript char count + first line). The reporter content script configures
// the extension to point at the mock, clicks Summarize, reads the rendered
// panel, and relays it back — so a PASS means the entire chain works, not just
// a mock talking to itself.

import { spawn } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const SRC = new URL("../src", import.meta.url).pathname;
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const VIDEO = process.argv[2] || "eIho2S0ZahI";
const DEBUG = process.env.YAPSUM_DEBUG === "1";

// ---- mock OpenAI-compatible server + report relay (one server) -------------

let resolveReport = null;
let sawLLMRequest = null;

const server = createServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = null, valid = false, transcriptChars = 0, firstLine = "", title = "";
      try {
        parsed = JSON.parse(body);
        const sys = parsed.messages?.find((m) => m.role === "system");
        const user = parsed.messages?.find((m) => m.role === "user");
        valid = !!(parsed.model && parsed.stream === true && sys && user);
        const m = (user?.content || "").match(/Video title: (.*)\n/);
        title = m ? m[1] : "";
        // The user prompt embeds the transcript after "Transcript ...:\n\n".
        const t = (user?.content || "").split(/Transcript[^\n]*:\n\n/)[1] || "";
        transcriptChars = t.length;
        firstLine = (t.split("\n")[0] || "").slice(0, 40);
      } catch {}
      sawLLMRequest = { valid, hasAuth: !!req.headers.authorization, transcriptChars, title };

      // Stream a summary in OpenAI SSE format, proving what we received.
      // Rich markdown so we can verify the panel renders formatted DOM.
      res.writeHead(200, { "content-type": "text/event-stream", ...cors });
      const summary =
        `SUMMARY_OK title="${title}" transcript_chars=${transcriptChars} first="${firstLine}"\n\n` +
        `### Key Takeaways\n\n` +
        `- **First** point about the video\n` +
        `- Second point two\n`;
      const words = summary.match(/\S+\s*/g) || [summary];
      let i = 0;
      const tick = setInterval(() => {
        if (i < words.length) {
          const frame = { choices: [{ delta: { content: words[i++] } }] };
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        } else {
          clearInterval(tick);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }, 15);
    });
    return;
  }

  if (req.method === "POST" && req.url === "/report") {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { res.writeHead(204, cors).end(); try { resolveReport?.(JSON.parse(b)); } catch { resolveReport?.({ ok: false }); } });
    return;
  }
  res.writeHead(404, cors).end();
});
const PORT = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

// ---- build temp ext = real src + config-setter bg + reporter ---------------

const ext = mkdtempSync(join(tmpdir(), "yapsum-full-"));
cpSync(SRC, ext, { recursive: true });
const mf = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
mf.permissions.push("http://127.0.0.1/*");
mf.background.scripts.push("smoke-bg.js");
mf.content_scripts[0].js.push("smoke-reporter.js");
writeFileSync(join(ext, "manifest.json"), JSON.stringify(mf));

// Point the extension at the mock endpoint before anything runs.
writeFileSync(
  join(ext, "smoke-bg.js"),
  `browser.storage.local.set({
     provider: "openai",
     baseUrl: "http://127.0.0.1:${PORT}/v1",
     model: "mock-model",
     apiKey: "test-key",
     maxTokens: 256,
   });
   browser.runtime.onMessage.addListener((m) => {
     if (m && m.__smoke) fetch("http://127.0.0.1:${PORT}/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) }).catch(() => {});
   });`
);

// Reproduce the real user flow: transcript already open, then Summarize.
writeFileSync(
  join(ext, "smoke-reporter.js"),
  `(async () => {
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     try {
       let btn = null;
       for (let i = 0; i < 40 && !btn; i++) { await sleep(500); btn = document.getElementById("yapsum-btn"); }
       if (!btn) { browser.runtime.sendMessage({ __smoke: true, ok: false, error: "no Summarize button" }); return; }

       // Open the transcript up front (as a user reading it would), then verify
       // the generic scraper reads the FULL transcript (wait for it to settle).
       try { await globalThis.yapSum.openTranscriptPanel(); } catch (e) {}
       let scrapeRows = 0, prev = -1;
       for (let i = 0; i < 40 && scrapeRows !== prev; i++) {
         prev = scrapeRows;
         await sleep(400);
         scrapeRows = (globalThis.yapSum.scrapeVisibleTranscript() || []).length;
       }

       await sleep(300);
       btn.click();
       let text = "", prevText = "", stable = 0;
       for (let i = 0; i < 130; i++) { // PAmodern extraction can take ~40s
         await sleep(500);
         const body = document.querySelector("#yapsum-panel .yapsum-panel-body");
         text = body ? body.textContent : "";
         if (body && body.classList.contains("yapsum-error")) break;
         if (text.includes("point two")) break;
         stable = text === prevText && text ? stable + 1 : 0;
         prevText = text;
         if (stable >= 3 && text.includes("SUMMARY_OK")) break;
       }
       await sleep(400); // let the final markdown render settle
       const body = document.querySelector("#yapsum-panel .yapsum-panel-body");
       let bgLog = null;
       try {
         const dbg = await browser.runtime.sendMessage({ type: "getDebug" });
         bgLog = (dbg.log || []).filter((e) => /timedtext|get_transcript|getCaptured|cc /.test(e.m)).slice(-25);
       } catch (e) { bgLog = String(e); }
       browser.runtime.sendMessage({
         __smoke: true,
         bgLog,
         ok: text.includes("SUMMARY_OK"),
         method: document.documentElement.dataset.yapsumMethod || "(unknown)",
         scrapeRows,
         renderedHeading: !!(body && body.querySelector("h3, h4")),
         renderedList: !!(body && body.querySelector("ul li")),
         renderedStrong: !!(body && body.querySelector("strong")),
         literalMarkdown: !!(body && body.textContent.includes("**")),
         panelText: text.slice(0, 400),
       });
     } catch (e) {
       browser.runtime.sendMessage({ __smoke: true, ok: false, error: "reporter threw: " + String(e) });
     }
   })();`
);

// ---- run --------------------------------------------------------------------

const profileDir = mkdtempSync(join(tmpdir(), "yapsum-ff-"));
const child = spawn("web-ext", [
  "run", "--source-dir", ext, "--firefox", FIREFOX, "--firefox-profile", profileDir,
  "--profile-create-if-missing", "--start-url", `https://www.youtube.com/watch?v=${VIDEO}`, "--no-reload", "--no-input",
], { stdio: DEBUG ? ["ignore", "inherit", "inherit"] : "ignore" });

const report = await new Promise((resolve) => {
  resolveReport = resolve;
  setTimeout(() => resolve({ ok: false, error: "timeout (150s)" }), 150000);
});
try { child.kill("SIGTERM"); } catch {}
server.close();

console.log("\n--- full-path verification (transcript open, as a real user) ---");
console.log("generic scraper read rows:", report.scrapeRows);
console.log("extraction method used:", report.method);
console.log("rich text rendered (heading/list/strong):", report.renderedHeading, "/", report.renderedList, "/", report.renderedStrong);
console.log("LLM endpoint received request:", JSON.stringify(sawLLMRequest));
console.log("panel showed:", JSON.stringify(report.panelText || report.error));
if (report.bgLog) console.log("bg capture log:", JSON.stringify(report.bgLog, null, 1));
const pass =
  report.ok &&
  (report.method === "intercept" || report.method === "captions-intercept" || report.method === "scrape") &&
  report.renderedHeading === true &&
  report.renderedList === true &&
  report.renderedStrong === true &&
  report.literalMarkdown === false &&
  sawLLMRequest?.valid &&
  sawLLMRequest?.transcriptChars > 5000;                      // the FULL transcript reached the LLM
console.log(
  pass
    ? `\n✅ PASS — transcript read (${report.method}), scraper got ${report.scrapeRows} rows, summarized as rich text`
    : "\n❌ FAIL"
);
process.exit(pass ? 0 : 1);
