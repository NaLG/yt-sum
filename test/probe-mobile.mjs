#!/usr/bin/env node
// Characterize m.youtube.com's watch page from inside real Firefox for Android
// (emulator or device): what transcript affordances exist in mobile markup?
//
// Reports (relayed content-script -> bg -> adb reverse -> this process):
//   - anchors: counts of key strings in page text (getTranscriptEndpoint,
//     captionTracks, engagementPanels, ...)
//   - transcript-ish controls (aria-label/text match), before and after
//     expanding the description sheet
//   - whether clicking "Show transcript" (if found) renders timestamp rows
//
// Usage: . scripts/android-env.sh && node test/probe-mobile.mjs [VIDEO_ID]

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const FIREFOX_APK = process.env.YAPSUM_FIREFOX_APK || "org.mozilla.firefox";
const videoId = process.argv[2] || "eIho2S0ZahI";

let resolveReport = null;
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(204).end();
      try { resolveReport?.(JSON.parse(body)); } catch { resolveReport?.({ error: "bad body" }); }
    });
    return;
  }
  res.writeHead(404).end();
});
const PORT = await new Promise((r) => server.listen(0, "0.0.0.0", () => r(server.address().port)));
execFileSync("adb", ["reverse", `tcp:${PORT}`, `tcp:${PORT}`]);

const extDir = mkdtempSync(join(tmpdir(), "yapsum-probe-"));
mkdirSync(extDir, { recursive: true });
writeFileSync(
  join(extDir, "manifest.json"),
  JSON.stringify({
    manifest_version: 2,
    name: "yap-sum mobile probe",
    version: "0.0.0",
    browser_specific_settings: { gecko: { id: "yapsum-probe@nalg.dev" } },
    permissions: ["https://www.youtube.com/*", "https://m.youtube.com/*", "http://127.0.0.1/*"],
    background: { scripts: ["bg.js"], persistent: false },
    content_scripts: [
      { matches: ["https://www.youtube.com/watch*", "https://m.youtube.com/watch*"], js: ["probe.js"], run_at: "document_idle" },
    ],
  })
);
writeFileSync(
  join(extDir, "bg.js"),
  `browser.runtime.onMessage.addListener(async (msg) => {
     // If the probe found captionTracks, try the timedtext fetch from the
     // background (host-permission fetch, no page CORS) before reporting.
     if (msg.timedtextUrl) {
       try {
         const res = await fetch(msg.timedtextUrl, { credentials: "include" });
         const text = await res.text();
         msg.timedtextFetch = { status: res.status, length: text.length, head: text.slice(0, 120) };
       } catch (e) {
         msg.timedtextFetch = { error: String(e) };
       }
     }
     fetch("http://127.0.0.1:${PORT}/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) }).catch(() => {});
   });`
);
writeFileSync(
  join(extDir, "probe.js"),
  `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { href: location.href, ua: navigator.userAgent.slice(0, 80) };
    for (let i = 0; i < 30; i++) { if (document.querySelector("video")) break; await sleep(500); }
    await sleep(2000);
    // Wait for the watch UI to settle (buttons rendered), up to 15s more.
    for (let i = 0; i < 30; i++) {
      if (document.querySelectorAll("button, [role=button]").length > 10) break;
      await sleep(500);
    }

    const pageText = () => Array.from(document.scripts, (s) => s.text || "").join("\\n") + document.documentElement.innerHTML;
    const countAnchors = () => {
      const t = pageText();
      const count = (needle) => t.split(needle).length - 1;
      return {
        getTranscriptEndpoint: count('"getTranscriptEndpoint"'),
        captionTracks: count('"captionTracks"'),
        engagementPanels: count('"engagementPanels"'),
        ytInitialPlayerResponse: count("ytInitialPlayerResponse"),
        INNERTUBE_API_KEY: count('"INNERTUBE_API_KEY"'),
        transcriptRenderers: count("transcriptSegmentRenderer"),
      };
    };
    const controls = () => {
      const found = [];
      for (const el of document.querySelectorAll("button, [role=button], a, ytm-button-renderer, yt-button-shape")) {
        const label = (el.getAttribute("aria-label") || "") + " | " + (el.textContent || "").trim().slice(0, 40);
        if (/transcript/i.test(label)) found.push({ tag: el.tagName.toLowerCase(), label: label.slice(0, 80) });
      }
      return found.slice(0, 8);
    };
    const tsRows = () => {
      let n = 0;
      for (const el of document.querySelectorAll("*")) {
        if (el.children.length === 0 && /^\\d{1,2}:\\d{2}(?::\\d{2})?$/.test((el.textContent || "").trim())) n++;
      }
      return n;
    };

    out.anchorsInitial = countAnchors();
    out.controlsInitial = controls();
    out.tsRowsInitial = tsRows();

    // Expand the DESCRIPTION sheet (not the 3-dot "More options" menu).
    const expanders = [];
    for (const el of document.querySelectorAll("button, [role=button], [class*=expand]")) {
      const label = (el.getAttribute("aria-label") || "") + " " + (el.textContent || "").trim().slice(0, 30);
      if (/show more|expand|description/i.test(label) && !/options/i.test(label)) expanders.push(el);
    }
    out.expanderCandidates = expanders.slice(0, 6).map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 60));
    if (expanders.length) { expanders[0].click(); await sleep(3000); }

    out.anchorsAfterExpand = countAnchors();
    out.controlsAfterExpand = controls();
    // Sample all control labels after expansion — discovery for mobile markup.
    const labels = [];
    for (const el of document.querySelectorAll("button, [role=button]")) {
      const l = ((el.getAttribute("aria-label") || "") + " " + (el.textContent || "").trim()).trim().slice(0, 50);
      if (l) labels.push(l);
    }
    out.buttonLabelsAfterExpand = [...new Set(labels)].slice(0, 40);

    // If a transcript control appeared, click it and watch for rows.
    const btn = Array.from(document.querySelectorAll("button, [role=button], a")).find((el) =>
      /transcript/i.test((el.getAttribute("aria-label") || "") + (el.textContent || ""))
    );
    if (btn) {
      btn.scrollIntoView();
      btn.click();
      for (let i = 0; i < 20; i++) { await sleep(500); if (tsRows() > out.tsRowsInitial + 3) break; }
      out.tsRowsAfterClick = tsRows();
      out.anchorsAfterClick = countAnchors();
    }

    // captionTracks from the LIVE page (the player has initialized by now):
    // report the first track's URL params and let bg try the actual fetch.
    // Balanced-bracket array extraction: the lazy-regex approach truncates on
    // nested }] (mobile name.runs) — same bug exists in extractor.js.
    const extractArray = (text, anchor) => {
      const idx = text.indexOf(anchor);
      if (idx === -1) return null;
      const start = text.indexOf("[", idx + anchor.length);
      if (start === -1) return null;
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (esc) esc = false;
        else if (c === "\\\\") esc = true;
        else if (c === '"') inStr = !inStr;
        else if (!inStr) {
          if (c === "[") depth++;
          else if (c === "]") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
        }
      }
      return null;
    };
    const tracks = extractArray(pageText(), '"captionTracks":');
    if (tracks) {
      try {
        const track = tracks.find((t) => (t.languageCode || "").startsWith("en")) || tracks[0];
        const raw = track.baseUrl.includes("\\\\u0026") ? JSON.parse('"' + track.baseUrl + '"') : track.baseUrl;
        const abs = /^https?:/.test(raw) ? raw : location.origin + raw; // mobile baseUrl is relative
        const params = abs.split("?")[1].split("&").map((p) => p.split("=")[0]);
        out.captionTrack = { count: tracks.length, lang: track.languageCode, kind: track.kind || "", params, hasPot: params.includes("pot") };
        browser.runtime.sendMessage({ ...out, timedtextUrl: abs + "&fmt=json3" });
        return;
      } catch (e) {
        out.captionTrackError = String(e);
      }
    }
    browser.runtime.sendMessage(out);
  })();`
);

const child = spawn(
  "web-ext",
  ["run", "--source-dir", extDir, "--no-reload", "--no-input", "--target", "firefox-android",
   "--android-device", (() => {
     const out = execFileSync("adb", ["devices"], { encoding: "utf8" });
     return out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter(([, s]) => s === "device").map(([id]) => id)[0];
   })(), "--firefox-apk", FIREFOX_APK],
  { stdio: ["ignore", "pipe", "ignore"] }
);
let buf = "";
child.stdout.on("data", (c) => {
  buf += c;
  if (/Installed .* as a temporary add-on/.test(buf)) {
    buf = "";
    execFileSync("adb", ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `https://www.youtube.com/watch?v=${videoId}`, FIREFOX_APK]);
    console.log("navigated; waiting for probe report...");
  }
});

const report = await new Promise((resolve) => {
  resolveReport = resolve;
  setTimeout(() => resolve({ error: "timeout (120s)" }), 120000);
});
try { child.kill("SIGTERM"); } catch {}
console.log(JSON.stringify(report, null, 2));
server.close();
process.exit(report.error ? 1 : 0);
