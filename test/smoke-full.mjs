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

const CHUNK = process.env.YAPSUM_CHUNK === "1"; // force map-reduce with tiny chunks

let resolveReport = null;
const llm = { parts: [], summary: null, followup: null }; // everything the mock saw

const server = createServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // Route by request shape: part-notes, follow-up, or summary/synthesis.
      // Reply proves what the background actually sent.
      let reply = "MOCK_CONFUSED";
      try {
        const parsed = JSON.parse(body);
        const sys = parsed.messages?.find((m) => m.role === "system");
        const users = parsed.messages?.filter((m) => m.role === "user") || [];
        const lastUser = users[users.length - 1]?.content || "";
        const valid = !!(parsed.model && parsed.stream === true && sys && users.length);

        if ((sys?.content || "").startsWith("You take dense notes")) {
          const pm = lastUser.match(/Transcript PART (\d+) of (\d+)/);
          const t = lastUser.split(/:\n\n/)[1] || "";
          llm.parts.push({ valid, part: pm ? +pm[1] : 0, of: pm ? +pm[2] : 0, chars: t.length });
          reply = `- NOTES_PART_${pm ? pm[1] : "?"} chars=${t.length}`;
        } else if ((sys?.content || "").startsWith("You answer follow-up")) {
          llm.followup = { valid, question: lastUser, messages: parsed.messages.length };
          reply = `**ANSWER_OK** to: ${lastUser}`;
        } else {
          const user = users[0]?.content || "";
          const title = (user.match(/Video title: (.*)\n/) || [])[1] || "";
          const synthesis = /sequential parts/.test(user);
          const t = user.split(/Transcript[^\n]*:\n\n/)[1] || "";
          llm.summary = {
            valid, hasAuth: !!req.headers.authorization, title, synthesis,
            transcriptChars: t.length,
            notesSeen: (user.match(/NOTES_PART_\d+/g) || []).length,
          };
          reply =
            `SUMMARY_OK title="${title}" transcript_chars=${t.length} first="${(t.split("\n")[0] || "").slice(0, 40)}"\n\n` +
            `### Key Takeaways\n\n` +
            `- **First** point about the video\n` +
            `- Second point two\n`;
        }
      } catch {}

      res.writeHead(200, { "content-type": "text/event-stream", ...cors });
      const words = reply.match(/\S+\s*/g) || [reply];
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
     ${CHUNK ? "chunkChars: 3000, maxChunks: 10," : ""}
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

       // Follow-up flow: type a question, click Ask, expect the streamed answer.
       let followupOk = false, followupRendered = false, followupErr = null;
       try {
         let inp = null, askBtn = null;
         for (let i = 0; i < 12 && !inp; i++) {
           await sleep(300);
           inp = document.querySelector("#yapsum-panel .yapsum-ask input");
           askBtn = document.querySelector("#yapsum-panel .yapsum-ask button");
         }
         if (!inp || !askBtn) throw new Error("follow-up UI not mounted");
         inp.value = "What is the second point?";
         askBtn.click();
         for (let i = 0; i < 40; i++) {
           await sleep(500);
           const a = document.querySelector("#yapsum-panel .yapsum-qa-a");
           if (a && a.textContent.includes("ANSWER_OK to: What is the second point?")) {
             followupOk = true;
             followupRendered = !!a.querySelector("strong"); // **ANSWER_OK** → <strong>
             break;
           }
         }
       } catch (e) { followupErr = String(e); }

       // Collapse: tap the title → panel folds (body hidden, node preserved);
       // tap again → restores. The summary text must survive the round-trip.
       let collapseOk = false, collapseErr = null;
       try {
         const panel = document.getElementById("yapsum-panel");
         const title = panel.querySelector(".yapsum-panel-title");
         const bodyEl = panel.querySelector(".yapsum-panel-body");
         const savedText = bodyEl.textContent;
         title.click(); await sleep(150);
         const collapsed = panel.classList.contains("yapsum-collapsed") && getComputedStyle(bodyEl).display === "none";
         title.click(); await sleep(150);
         const expanded = !panel.classList.contains("yapsum-collapsed") && getComputedStyle(bodyEl).display !== "none";
         const preserved = bodyEl.textContent === savedText && savedText.includes("SUMMARY_OK");
         collapseOk = collapsed && expanded && preserved;
         if (!collapseOk) collapseErr = JSON.stringify({ collapsed, expanded, preserved });
       } catch (e) { collapseErr = String(e); }

       // Drag + resize (desktop): a bar drag of (60,40) must move the panel
       // exactly that far WITHOUT toggling collapse, and dragging the SE grip
       // by (40,30) must grow it exactly that much. Synthetic PointerEvents
       // carry no active pointer id so dragSession skips pointer capture; the
       // listeners sit on the bar/grip, so dispatching at them still works.
       let dragOk = false, dragErr = null;
       try {
         const panel = document.getElementById("yapsum-panel");
         const bar = panel.querySelector(".yapsum-panel-bar");
         const pe = (el, type, x, y) =>
           el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, clientX: x, clientY: y }));
         const r0 = panel.getBoundingClientRect();
         pe(bar, "pointerdown", r0.left + 50, r0.top + 15);
         pe(bar, "pointermove", r0.left + 110, r0.top + 55);
         pe(bar, "pointerup", r0.left + 110, r0.top + 55);
         await sleep(60); // let the drag's click-swallow timeout clear
         const r1 = panel.getBoundingClientRect();
         const movedX = Math.round(r1.left - r0.left), movedY = Math.round(r1.top - r0.top);
         const stayedOpen = !panel.classList.contains("yapsum-collapsed");
         const grip = panel.querySelector(".yapsum-rs-se");
         const g = grip.getBoundingClientRect();
         pe(grip, "pointerdown", g.left + 4, g.top + 4);
         pe(grip, "pointermove", g.left + 44, g.top + 34);
         pe(grip, "pointerup", g.left + 44, g.top + 34);
         await sleep(60);
         const r2 = panel.getBoundingClientRect();
         const grewW = Math.round(r2.width - r1.width), grewH = Math.round(r2.height - r1.height);
         dragOk = movedX === 60 && movedY === 40 && stayedOpen && grewW === 40 && grewH === 30;
         if (!dragOk) dragErr = JSON.stringify({ movedX, movedY, stayedOpen, grewW, grewH });
       } catch (e) { dragErr = String(e); }

       // Collapse-in-place (collapseInPlace setting): with the panel at the
       // custom position/size the drag test left it, folding must keep
       // left/top/width and only shrink the height to the bar; expanding must
       // restore the exact height. Runs right here because the inline
       // geometry is what corner mode sheds and in-place mode must keep.
       let inplaceOk = false, inplaceErr = null;
       try {
         await browser.storage.local.set({ collapseInPlace: true });
         await sleep(120); // let storage.onChanged reach the content script
         const panel = document.getElementById("yapsum-panel");
         const title = panel.querySelector(".yapsum-panel-title");
         const bodyEl = panel.querySelector(".yapsum-panel-body");
         const r0 = panel.getBoundingClientRect();
         title.click(); await sleep(120);
         const rc = panel.getBoundingClientRect();
         const folded = panel.classList.contains("yapsum-collapsed") && getComputedStyle(bodyEl).display === "none";
         const stayedPut = Math.round(rc.left) === Math.round(r0.left) && Math.round(rc.top) === Math.round(r0.top)
           && Math.round(rc.width) === Math.round(r0.width) && rc.height < r0.height - 50;
         title.click(); await sleep(120);
         const re = panel.getBoundingClientRect();
         const restored = !panel.classList.contains("yapsum-collapsed")
           && Math.round(re.height) === Math.round(r0.height) && Math.round(re.left) === Math.round(r0.left);
         await browser.storage.local.set({ collapseInPlace: false });
         inplaceOk = folded && stayedPut && restored;
         if (!inplaceOk) inplaceErr = JSON.stringify({ folded, stayedPut, restored,
           r0: [r0.left, r0.top, r0.width, r0.height].map(Math.round),
           rc: [rc.left, rc.top, rc.width, rc.height].map(Math.round),
           re: [re.left, re.top, re.width, re.height].map(Math.round) });
       } catch (e) { inplaceErr = String(e); }

       let bgLog = null;
       try {
         const dbg = await browser.runtime.sendMessage({ type: "getDebug" });
         bgLog = (dbg.log || []).filter((e) => /timedtext|get_transcript|getCaptured|cc /.test(e.m)).slice(-25);
       } catch (e) { bgLog = String(e); }
       browser.runtime.sendMessage({
         __smoke: true,
         bgLog,
         followupOk, followupRendered, followupErr,
         collapseOk, collapseErr,
         dragOk, dragErr,
         inplaceOk, inplaceErr,
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
  // Headed Firefox can't start while the macOS session is locked; headless
  // renders identically (same UA) and keeps the suite runnable unattended.
  ...(process.env.YAPSUM_HEADLESS === "1" ? ["--arg=-headless"] : []),
], { stdio: DEBUG ? ["ignore", "inherit", "inherit"] : "ignore" });

const report = await new Promise((resolve) => {
  resolveReport = resolve;
  setTimeout(() => resolve({ ok: false, error: "timeout (150s)" }), 150000);
});
try { child.kill("SIGTERM"); } catch {}
server.close();

console.log(`\n--- full-path verification (transcript open, as a real user${CHUNK ? "; CHUNKED mode" : ""}) ---`);
console.log("generic scraper read rows:", report.scrapeRows);
console.log("extraction method used:", report.method);
console.log("rich text rendered (heading/list/strong):", report.renderedHeading, "/", report.renderedList, "/", report.renderedStrong);
console.log("LLM summary request:", JSON.stringify(llm.summary));
if (CHUNK) console.log("LLM part requests:", JSON.stringify(llm.parts));
console.log("LLM follow-up request:", JSON.stringify(llm.followup));
console.log("follow-up:", report.followupOk, "rendered:", report.followupRendered, report.followupErr || "");
console.log("collapse/expand preserves summary:", report.collapseOk, report.collapseErr || "");
console.log("bar drag moves + SE grip resizes:", report.dragOk, report.dragErr || "");
console.log("collapse-in-place keeps position:", report.inplaceOk, report.inplaceErr || "");
console.log("panel showed:", JSON.stringify(report.panelText || report.error));
if (!report.ok && report.bgLog) console.log("bg capture log:", JSON.stringify(report.bgLog, null, 1));
const partChars = llm.parts.reduce((a, p) => a + p.chars, 0);
const pass =
  report.ok &&
  (report.method === "intercept" || report.method === "captions-intercept" || report.method === "scrape") &&
  report.renderedHeading === true &&
  report.renderedList === true &&
  report.renderedStrong === true &&
  report.literalMarkdown === false &&
  llm.summary?.valid &&
  llm.summary?.hasAuth &&
  // The FULL transcript reached the LLM: directly, or covered by part notes.
  (CHUNK
    ? llm.parts.length >= 2 && llm.parts.every((p) => p.valid) && llm.summary.synthesis && llm.summary.notesSeen === llm.parts.length && partChars > 5000
    : llm.summary.transcriptChars > 5000) &&
  report.followupOk === true &&
  report.followupRendered === true &&
  report.collapseOk === true &&
  report.dragOk === true &&
  report.inplaceOk === true &&
  llm.followup?.valid &&
  llm.followup?.messages >= 4; // system+transcript+assistant-summary+question
console.log(
  pass
    ? `\n✅ PASS — transcript read (${report.method}), ${CHUNK ? `${llm.parts.length} chunks, ` : ""}summarized as rich text, follow-up answered`
    : "\n❌ FAIL"
);
process.exit(pass ? 0 : 1);
