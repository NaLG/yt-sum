#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const SRC = new URL("../src", import.meta.url).pathname;
const ARTIFACTS = new URL("./artifacts", import.meta.url).pathname;
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const VIDEO = process.argv[2] || "eIho2S0ZahI";
const DEBUG = process.env.YAPSUM_DEBUG === "1";

const CHUNK = process.env.YAPSUM_CHUNK === "1";

let resolveReport = null;
const llm = { parts: [], summary: null, followup: null, requests: [] };

const server = createServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let reply = "MOCK_CONFUSED";
      let finishReason = "stop";
      try {
        const parsed = JSON.parse(body);
        const sys = parsed.messages?.find((m) => m.role === "system");
        const users = parsed.messages?.filter((m) => m.role === "user") || [];
        const lastUser = users[users.length - 1]?.content || "";
        const valid = !!(parsed.model && parsed.stream === true && sys && users.length);

        const kind = (sys?.content || "").startsWith("You take dense notes") ? "notes"
          : (sys?.content || "").startsWith("You answer follow-up") ? "followup" : "summary";
        llm.requests.push({ kind, model: parsed.model, auth: req.headers.authorization || "" });
        if (kind === "notes") {
          const pm = lastUser.match(/Transcript PART (\d+) of (\d+)/);
          const t = lastUser.split(/:\n\n/)[1] || "";
          if (!llm.summary) llm.parts.push({ valid, part: pm ? +pm[1] : 0, of: pm ? +pm[2] : 0, chars: t.length });
          reply = `- NOTES_PART_${pm ? pm[1] : "?"} chars=${t.length}`;
        } else if (kind === "followup") {
          if (!llm.followup) llm.followup = { valid, question: lastUser, messages: parsed.messages.length };
          reply = `**ANSWER_OK** model=${parsed.model} to: ${lastUser}`;
          finishReason = "length";
        } else {
          const user = users[0]?.content || "";
          const title = (user.match(/Video title: (.*)\n/) || [])[1] || "";
          const synthesis = /sequential parts/.test(user);
          const t = user.split(/Transcript[^\n]*:\n\n/)[1] || "";
          if (!llm.summary)
            llm.summary = {
              valid, hasAuth: !!req.headers.authorization, title, synthesis,
              transcriptChars: t.length,
              notesSeen: (user.match(/NOTES_PART_\d+/g) || []).length,
            };
          reply =
            `SUMMARY_OK model=${parsed.model} title="${title}" transcript_chars=${t.length} first="${(t.split("\n")[0] || "").slice(0, 40)}"\n\n` +
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
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
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

  if (req.method === "POST" && req.url === "/shot") {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.writeHead(204, cors).end();
      try {
        const m = JSON.parse(b);
        const name = /^[a-z0-9-]{1,40}$/.test(m.name || "") ? m.name : "shot";
        mkdirSync(ARTIFACTS, { recursive: true });
        writeFileSync(join(ARTIFACTS, `${name}.png`), Buffer.from(m.dataUrl.split(",")[1], "base64"));
      } catch {}
    });
    return;
  }
  res.writeHead(404, cors).end();
});
const PORT = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

const ext = mkdtempSync(join(tmpdir(), "yapsum-full-"));
cpSync(SRC, ext, { recursive: true });
const mf = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
mf.permissions.push("http://127.0.0.1/*", "<all_urls>");
mf.background.scripts.push("smoke-bg.js");
mf.content_scripts[0].js.push("smoke-reporter.js");
writeFileSync(join(ext, "manifest.json"), JSON.stringify(mf));

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
   // Listener MUST stay synchronous: an async listener's returned promise can
   // claim the response channel for EVERY runtime message, racing the real
   // background handlers (getCaptured, getModels…) and randomly feeding the
   // content script undefined instead of its data.
   // keep synchronous: an async listener claims every message response channel
   browser.runtime.onMessage.addListener((m) => {
     if (m && m.__smoke) fetch("http://127.0.0.1:${PORT}/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) }).catch(() => {});
     if (m && m.__shot) {
       browser.tabs.captureVisibleTab(null, { format: "png" })
         .then((dataUrl) => dataUrl && fetch("http://127.0.0.1:${PORT}/shot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataUrl, name: m.__shot }) }))
         .catch(() => {});
     }
   });`
);

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
       let truncNoticeOk = false, spuriousNotice = false;
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
           if (a && a.textContent.includes("ANSWER_OK") && a.textContent.includes("to: What is the second point?")) {
             followupOk = true;
             followupRendered = !!a.querySelector("strong"); // **ANSWER_OK** → <strong>
             break;
           }
         }
         await sleep(300); // the truncation notice is appended after the final render
         // Mock ends the follow-up with finish_reason "length": its truncation
         // notice must render inside the answer; the summary ended "stop", so
         // a body-level notice there would be spurious.
         const note = document.querySelector("#yapsum-panel .yapsum-qa-a .yapsum-note");
         truncNoticeOk = !!note && /max-tokens/.test(note.textContent);
         spuriousNotice = !!document.querySelector("#yapsum-panel .yapsum-panel-body > .yapsum-note");
       } catch (e) { followupErr = String(e); }

       // ---- default-model switch + picker --------------------------------
       // Regression (reported 2026-07-20): switching the model in settings and
       // re-summarizing the SAME video served the old model's cached summary
       // with no LLM call. The mock echoes model=<id> into every reply, so the
       // panel text itself proves which model actually served each summary.
       let pickerSoloOk = false, modelSwitchOk = false, pickerOk = false,
           pickerFollowupOk = false, pickerCacheOk = false, modelErr = null;
       let pickerVisible = false, pickerDefaultOk = false, pickerGeom = null;
       // Streams end with "point two"; waiting for it (plus a settle) means
       // the final render + follow-up bar remount are done before we poke on.
       const streamed = async (marker, tries) => {
         for (let i = 0; i < tries; i++) {
           await sleep(400);
           const b = document.querySelector("#yapsum-panel .yapsum-panel-body");
           if (b && b.textContent.includes(marker) && b.textContent.includes("point two")) {
             await sleep(800);
             return true;
           }
         }
         return false;
       };
       try {
         // Even with NO extra models the chip must render, showing the one
         // model that will run (its absence kept reading as a broken feature).
         const solo = document.querySelector("#yapsum-panel .yapsum-model");
         pickerSoloOk = !!solo && solo.options.length === 1 && solo.options[0].textContent === "mock-model";
         await browser.storage.local.set({
           model: "mock-model-2",
           extraModels: [{ id: "x1", label: "kimi-k3", provider: "openai", baseUrl: "http://127.0.0.1:${PORT}/v1", model: "moonshotai/kimi-k3", apiKey: "key-2" }],
         });
         // Re-query the button: YouTube hydration can have replaced the node
         // since the first click.
         (document.getElementById("yapsum-btn") || btn).click(); // same video, new default model: must NOT serve the stale cache
         modelSwitchOk = await streamed("model=mock-model-2", 40);
         // Visibility, not DOM presence: rendered, sized, inside the bar's
         // box, on screen, enabled, and showing the expected label. DOM
         // presence alone has fooled us before.
         const pickerVis = (wantLabel) => {
           const s = document.querySelector("#yapsum-panel .yapsum-model");
           const b = document.querySelector("#yapsum-panel .yapsum-panel-bar");
           if (!s || !b) return { ok: false, geom: null };
           const sr = s.getBoundingClientRect();
           const br = b.getBoundingClientRect();
           const cs = getComputedStyle(s);
           return {
             ok: cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.2 &&
                 sr.width >= 20 && sr.height >= 10 &&
                 sr.top >= br.top - 1 && sr.bottom <= br.bottom + 1 &&
                 sr.left >= br.left && sr.right <= br.right &&
                 sr.top >= 0 && sr.bottom <= innerHeight &&
                 sr.left >= 0 && sr.right <= innerWidth + 1 && !s.disabled && // fully on screen, no clipped label
                 !!s.selectedOptions[0] && s.selectedOptions[0].textContent === wantLabel,
             geom: { sel: [sr.left, sr.top, sr.width, sr.height].map(Math.round), bar: [br.left, br.top, br.width, br.height].map(Math.round) },
           };
         };
         const sel = document.querySelector("#yapsum-panel .yapsum-model");
         if (!sel) throw new Error("model picker not mounted after adding extraModels");
         // DEFAULT state first: extras exist, nothing picked yet, so the chip
         // must already be visible and showing the DEFAULT model's id.
         const dv = pickerVis("mock-model-2");
         pickerDefaultOk = dv.ok && sel.value === "";
         pickerGeom = dv.geom;
         browser.runtime.sendMessage({ __shot: "model-picker-default" });
         await sleep(900); // let the capture land before the panel changes
         const kimiOpt = [...sel.options].find((o) => o.textContent.includes("kimi-k3"));
         if (!kimiOpt) throw new Error("kimi-k3 missing from picker");
         sel.value = kimiOpt.value;
         sel.dispatchEvent(new Event("change", { bubbles: true }));
         pickerOk = await streamed("model=moonshotai/kimi-k3", 40);
         pickerVisible = pickerVis("kimi-k3").ok;
         browser.runtime.sendMessage({ __shot: "model-picker" });
         await sleep(900);
         const inp2 = document.querySelector("#yapsum-panel .yapsum-ask input");
         const ask2 = document.querySelector("#yapsum-panel .yapsum-ask button");
         if (inp2 && ask2) {
           inp2.value = "Which model?";
           ask2.click();
           for (let i = 0; i < 30 && !pickerFollowupOk; i++) {
             await sleep(400);
             pickerFollowupOk = [...document.querySelectorAll("#yapsum-panel .yapsum-qa-a")]
               .some((a) => a.textContent.includes("model=moonshotai/kimi-k3 to: Which model?"));
           }
         }
         // Back to default: must render from the per-model cache (the node side
         // asserts exactly ONE mock-model-2 summary request total).
         sel.value = "";
         sel.dispatchEvent(new Event("change", { bubbles: true }));
         for (let i = 0; i < 15 && !pickerCacheOk; i++) {
           await sleep(400);
           const b = document.querySelector("#yapsum-panel .yapsum-panel-body");
           pickerCacheOk = !!b && b.textContent.includes("model=mock-model-2");
         }
       } catch (e) { modelErr = String(e); }

       // ---- auto-summarize OFF: panel parks and waits --------------------
       // New default model with no cache: the click must open a waiting state
       // (run button, ZERO spend), switching to a cached model shows it free,
       // asking works before any summary exists, and only the explicit run
       // button starts the stream.
       let waitOk = false, waitCachedFlipOk = false, waitAskOk = false, waitRunOk = false, waitErr = null;
       try {
         await browser.storage.local.set({ autoSummarize: false, model: "mock-model-3" });
         (document.getElementById("yapsum-btn") || btn).click();
         let runBtn = null;
         for (let i = 0; i < 20 && !runBtn; i++) { await sleep(300); runBtn = document.querySelector("#yapsum-panel .yapsum-run-btn"); }
         const wBody = document.querySelector("#yapsum-panel .yapsum-panel-body")?.textContent || "";
         waitOk = !!runBtn && !wBody.includes("model=mock-model-3");
         const sel3 = document.querySelector("#yapsum-panel .yapsum-model");
         if (!sel3) throw new Error("picker missing in waiting state");
         // Cached model flip: kimi's summary appears with no new request.
         const kimi3 = [...sel3.options].find((o) => o.textContent.includes("kimi-k3"));
         sel3.value = kimi3.value;
         sel3.dispatchEvent(new Event("change", { bubbles: true }));
         for (let i = 0; i < 15 && !waitCachedFlipOk; i++) {
           await sleep(400);
           waitCachedFlipOk = (document.querySelector("#yapsum-panel .yapsum-panel-body")?.textContent || "").includes("model=moonshotai/kimi-k3");
         }
         // Back to the never-run default: waiting again, ask BEFORE a summary.
         sel3.value = "";
         sel3.dispatchEvent(new Event("change", { bubbles: true }));
         runBtn = null;
         for (let i = 0; i < 15 && !runBtn; i++) { await sleep(300); runBtn = document.querySelector("#yapsum-panel .yapsum-run-btn"); }
         const wInp = document.querySelector("#yapsum-panel .yapsum-ask input");
         const wAskBtn = document.querySelector("#yapsum-panel .yapsum-ask button");
         if (runBtn && wInp && wAskBtn) {
           wInp.value = "Early question?";
           wAskBtn.click();
           for (let i = 0; i < 30 && !waitAskOk; i++) {
             await sleep(400);
             waitAskOk = [...document.querySelectorAll("#yapsum-panel .yapsum-qa-a")]
               .some((a) => a.textContent.includes("model=mock-model-3 to: Early question?"));
           }
         }
         // Only the explicit button starts the summary stream.
         document.querySelector("#yapsum-panel .yapsum-run-btn")?.click();
         waitRunOk = await streamed("model=mock-model-3", 40);
       } catch (e) { waitErr = String(e); }
       await browser.storage.local.set({ autoSummarize: true }); // restore for later sections

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
         followupOk, followupRendered, followupErr, truncNoticeOk, spuriousNotice,
         collapseOk, collapseErr,
         dragOk, dragErr,
         inplaceOk, inplaceErr,
         pickerSoloOk, modelSwitchOk, pickerOk, pickerFollowupOk, pickerCacheOk, modelErr, pickerVisible, pickerDefaultOk, pickerGeom,
         waitOk, waitCachedFlipOk, waitAskOk, waitRunOk, waitErr,
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

const profileDir = mkdtempSync(join(tmpdir(), "yapsum-ff-"));
const child = spawn("web-ext", [
  "run", "--source-dir", ext, "--firefox", FIREFOX, "--firefox-profile", profileDir,
  "--profile-create-if-missing", "--start-url", `https://www.youtube.com/watch?v=${VIDEO}`, "--no-reload", "--no-input",
  ...(process.env.YAPSUM_HEADLESS === "1" ? ["--arg=-headless"] : []),
], { stdio: DEBUG ? ["ignore", "inherit", "inherit"] : "ignore" });

const report = await new Promise((resolve) => {
  resolveReport = resolve;
  setTimeout(() => resolve({ ok: false, error: "timeout (150s)" }), 150000);
});
try { child.kill("SIGTERM"); } catch {}
try { execFileSync("/bin/sh", ["-c", `sleep 2; pkill -f 'firefox.*-profile ${tmpdir()}'; true`]); } catch {}
server.close();

console.log(`\n--- full-path verification (transcript open, as a real user${CHUNK ? "; CHUNKED mode" : ""}) ---`);
console.log("generic scraper read rows:", report.scrapeRows);
console.log("extraction method used:", report.method);
console.log("rich text rendered (heading/list/strong):", report.renderedHeading, "/", report.renderedList, "/", report.renderedStrong);
console.log("LLM summary request:", JSON.stringify(llm.summary));
if (CHUNK) console.log("LLM part requests:", JSON.stringify(llm.parts));
console.log("LLM follow-up request:", JSON.stringify(llm.followup));
console.log("follow-up:", report.followupOk, "rendered:", report.followupRendered, report.followupErr || "");
console.log("truncation notice shown (followup) / absent (summary):", report.truncNoticeOk, "/", !report.spuriousNotice);
console.log("collapse/expand preserves summary:", report.collapseOk, report.collapseErr || "");
console.log("bar drag moves + SE grip resizes:", report.dragOk, report.dragErr || "");
console.log("collapse-in-place keeps position:", report.inplaceOk, report.inplaceErr || "");
console.log(
  "model switch / picker / picker-followup / cache-flip / solo-chip:",
  report.modelSwitchOk, "/", report.pickerOk, "/", report.pickerFollowupOk, "/", report.pickerCacheOk, "/", report.pickerSoloOk,
  report.modelErr || ""
);
console.log(
  "auto-off: waits / cached-flip free / ask-first / explicit run:",
  report.waitOk, "/", report.waitCachedFlipOk, "/", report.waitAskOk, "/", report.waitRunOk,
  report.waitErr || ""
);
console.log(
  "picker VISIBLE in DEFAULT state / after switch:", report.pickerDefaultOk, "/", report.pickerVisible,
  JSON.stringify(report.pickerGeom),
  "(screenshots: test/artifacts/model-picker-default.png, model-picker.png)"
);
console.log("panel showed:", JSON.stringify(report.panelText || report.error));
if (!report.ok && report.bgLog) console.log("bg capture log:", JSON.stringify(report.bgLog, null, 1));
const partChars = llm.parts.reduce((a, p) => a + p.chars, 0);
const model2Calls = llm.requests.filter((r) => r.model === "mock-model-2" && r.kind !== "notes").length;
const kimiReqs = llm.requests.filter((r) => r.model === "moonshotai/kimi-k3");
const kimiKeyOk = kimiReqs.length >= 2 && kimiReqs.every((r) => r.auth === "Bearer key-2");
const model3Sums = llm.requests.filter((r) => r.model === "mock-model-3" && r.kind === "summary").length;
const model3Fups = llm.requests.filter((r) => r.model === "mock-model-3" && r.kind === "followup").length;
console.log("mock-model-2 summarize calls (want 1):", model2Calls, "| kimi reqs:", kimiReqs.length, "kimi key ok:", kimiKeyOk);
console.log("auto-off spend audit, model-3 summaries/followups (want 1/1):", model3Sums, "/", model3Fups);
const pass =
  report.ok &&
  (report.method === "intercept" || report.method === "captions-intercept" || report.method === "scrape") &&
  report.renderedHeading === true &&
  report.renderedList === true &&
  report.renderedStrong === true &&
  report.literalMarkdown === false &&
  llm.summary?.valid &&
  llm.summary?.hasAuth &&
  (CHUNK
    ? llm.parts.length >= 2 && llm.parts.every((p) => p.valid) && llm.summary.synthesis && llm.summary.notesSeen === llm.parts.length && partChars > 5000
    : llm.summary.transcriptChars > 5000) &&
  report.followupOk === true &&
  report.followupRendered === true &&
  report.truncNoticeOk === true &&
  report.spuriousNotice === false &&
  report.collapseOk === true &&
  report.dragOk === true &&
  report.inplaceOk === true &&
  report.pickerSoloOk === true &&
  report.modelSwitchOk === true &&
  report.pickerOk === true &&
  report.pickerVisible === true &&
  report.pickerDefaultOk === true &&
  report.pickerFollowupOk === true &&
  report.pickerCacheOk === true &&
  report.waitOk === true &&
  report.waitCachedFlipOk === true &&
  report.waitAskOk === true &&
  report.waitRunOk === true &&
  model2Calls === 1 &&
  model3Sums === 1 &&
  model3Fups === 1 &&
  kimiKeyOk &&
  llm.followup?.valid &&
  llm.followup?.messages >= 4;
console.log(
  pass
    ? `\n✅ PASS; transcript read (${report.method}), ${CHUNK ? `${llm.parts.length} chunks, ` : ""}summarized as rich text, follow-up answered`
    : "\n❌ FAIL"
);
process.exit(pass ? 0 : 1);
