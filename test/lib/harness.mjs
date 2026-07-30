import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import * as android from "./android.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const FIREFOX = process.env.YAPSUM_FIREFOX || "/Applications/Firefox.app/Contents/MacOS/firefox";
const DEBUG = process.env.YAPSUM_DEBUG === "1";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function exportGitRef(ref, { root = ROOT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `yapsum-ref-${ref.replace(/[^a-z0-9]/gi, "")}-`));
  execFileSync("/bin/sh", ["-c", `git -C ${root} archive ${ref} src | tar -x -C ${dir}`]);
  return join(dir, "src");
}

const OBSERVE_PATTERNS = {
  timedtext: "*://*.youtube.com/api/timedtext*",
  get_transcript: "*://*.youtube.com/youtubei/v1/get_transcript*",
  player: "*://*.youtube.com/youtubei/v1/player*",
};

function buildBackground({ port, observe, closeExistingTabs, extra }) {
  const patterns = observe.map((k) => OBSERVE_PATTERNS[k]).filter(Boolean);
  return `
const __PORT = ${port};
const __post = (path, body) =>
  fetch("http://127.0.0.1:" + __PORT + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => {});
const ev = (kind, data) => __post("/ev", { kind, t: Date.now(), ...(data || {}) });
globalThis.__harnessEv = ev;

const __closeYouTubeTabs = async () => {
  try {
    const ts = await browser.tabs.query({});
    const doomed = ts.filter((t) => /youtube\\.com/.test(t.url || ""));
    for (const t of doomed) await browser.tabs.remove(t.id).catch(() => {});
    return doomed.length;
  } catch (e) { return -1; }
};
globalThis.__bgCmd = async (cmd) => {
  if (cmd.kind === "closeYouTubeTabs") return { closed: await __closeYouTubeTabs() };
  if (cmd.kind === "listTabs") {
    const ts = await browser.tabs.query({});
    return ts.map((t) => ({ id: t.id, url: (t.url || "").slice(0, 90) }));
  }
  return { err: "unknown bg cmd " + cmd.kind };
};

${patterns.length ? `
const __readBody = (requestId, meta) => {
  try {
    const f = browser.webRequest.filterResponseData(requestId);
    const chunks = [];
    f.ondata = (e) => { chunks.push(new Uint8Array(e.data)); f.write(e.data); };
    f.onstop = () => {
      f.close();
      let text = "", err = null;
      try {
        let total = 0;
        for (const c of chunks) total += c.length;
        const all = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        text = new TextDecoder("utf-8").decode(all);
      } catch (e) { err = String(e); }
      let segs = null, parseErr = null;
      if (text) {
        try {
          const j = JSON.parse(text);
          if (Array.isArray(j.events)) segs = j.events.filter((e2) => e2.segs).length;
          else segs = (JSON.stringify(j).match(/transcriptSegmentRenderer/g) || []).length;
        } catch (e) { parseErr = String(e).slice(0, 80); }
      }
      ev("net-body", { ...meta, bytes: text.length, segs, parseErr, err, first: text.slice(0, 40) });
    };
    f.onerror = () => ev("net-filter-error", { ...meta, err: String(f.error) });
  } catch (e) { ev("net-filter-error", { ...meta, err: String(e) }); }
};
browser.webRequest.onBeforeRequest.addListener(
  (d) => {
    let q = null;
    try { q = new URL(d.url).searchParams; } catch {}
    const meta = {
      ep: d.url.includes("timedtext") ? "timedtext" : d.url.includes("get_transcript") ? "get_transcript" : "player",
      v: q ? q.get("v") : null,
      pot: q ? q.has("pot") : null,
      fmt: q ? q.get("fmt") : null,
      trackKind: q ? q.get("kind") : null,
      lang: q ? q.get("lang") : null,
      url: d.url.slice(0, 160),
    };
    ev("net-request", meta);
    __readBody(d.requestId, meta);
    return {};
  },
  { urls: ${JSON.stringify(patterns)} },
  ["blocking"]
);
` : ""}

let __cmdId = 0;
setInterval(async () => {
  try {
    const r = await fetch("http://127.0.0.1:" + __PORT + "/cmd");
    const cmd = await r.json();
    if (!cmd.id || cmd.id === __cmdId) return;
    if (cmd.scope !== "bg") {
      const tabs = await browser.tabs.query({});
      const candidates = tabs.filter((t) => (t.url || "").includes(cmd.match || "youtube.com"));
      const target = candidates.find((t) => t.active) || candidates.sort((a, b) => b.id - a.id)[0];
      if (target && !target.active) await browser.tabs.update(target.id, { active: true }).catch(() => {});
      return;
    }
    __cmdId = cmd.id;
    let value = null, error = null;
    try {
      value = typeof globalThis.__bgCmd === "function" ? await globalThis.__bgCmd(cmd) : { err: "no bg handler" };
    } catch (e) { error = String(e); }
    __post("/result", { id: cmd.id, kind: cmd.kind, value, error });
  } catch {}
}, 400);

${closeExistingTabs ? "__closeYouTubeTabs()" : "Promise.resolve(0)"}.then((closed) =>
  ev("harness-bg-ready", { apis: Object.keys(browser).sort().join(","), closedTabs: closed })
);
${extra || ""}
`;
}

function buildContent({ port, extra }) {
  return `
(() => {
  const __PORT = ${port};
  const __handlers = {};
  globalThis.onCmd = (kind, fn) => { __handlers[kind] = fn; };
  globalThis.ev = (kind, data) =>
    fetch("http://127.0.0.1:" + __PORT + "/ev", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, t: Date.now(), from: "content", ...(data || {}) }),
    }).catch(() => {});
  let __seen = 0;
  setInterval(async () => {
    if (document.visibilityState !== "visible") return;
    let cmd = null;
    try {
      const r = await fetch("http://127.0.0.1:" + __PORT + "/cmd");
      cmd = await r.json();
    } catch { return; }
    if (!cmd || !cmd.id || cmd.id === __seen || cmd.scope === "bg") return;
    if (cmd.match && !location.href.includes(cmd.match)) return;
    __seen = cmd.id;
    const fn = __handlers[cmd.kind];
    let value = null, error = null;
    if (!fn) error = "no handler: " + cmd.kind;
    else {
      try { value = await fn(cmd.payload); } catch (e) { error = String(e); }
    }
    fetch("http://127.0.0.1:" + __PORT + "/result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: cmd.id, kind: cmd.kind, value, error, href: location.href }),
    }).catch(() => {});
  }, 400);
  ${extra || ""}
})();
`;
}

export function createHarness(options = {}) {
  const {
    target = "desktop",
    site = target === "android" ? "mweb" : "desktop",
    srcDir = null,
    bare = false,
    observe = [],
    bg = "",
    content = "",
    contentMatches = ["https://www.youtube.com/watch*", "https://m.youtube.com/watch*", "https://m.youtube.com/shorts*", "https://www.youtube.com/shorts*"],
    closeExistingTabs = target === "android",
    headless = process.env.YAPSUM_HEADLESS === "1",
    artifacts = join(ROOT, "test", "artifacts"),
  } = options;

  const events = [];
  const results = new Map();
  const cmdQueue = [];
  let cmdSeq = 0;
  let child = null;
  let extDir = null;
  let profileDir = null;
  let installed = false;
  let openSeq = 0;

  const server = createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    if (req.method === "GET" && req.url === "/cmd") {
      return res.writeHead(200, { "content-type": "application/json", ...cors }).end(JSON.stringify(cmdQueue[0] || {}));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(204, cors).end();
      let msg = null;
      try { msg = JSON.parse(body); } catch { return; }
      if (req.url === "/ev") {
        events.push(msg);
        if (DEBUG) console.log("  [ev]", JSON.stringify(msg).slice(0, 200));
      } else if (req.url === "/result") {
        results.set(msg.id, msg);
        if (cmdQueue[0] && cmdQueue[0].id === msg.id) cmdQueue.shift();
        if (DEBUG) console.log("  [result]", JSON.stringify(msg).slice(0, 200));
      }
    });
  });

  const api = {
    port: null,
    events,
    get installed() { return installed; },

    async listen() {
      api.port = await new Promise((r) =>
        server.listen(0, target === "android" ? "0.0.0.0" : "127.0.0.1", () => r(server.address().port))
      );
      if (target === "android") android.reversePort(api.port);
      return api.port;
    },

    build() {
      extDir = mkdtempSync(join(tmpdir(), "yapsum-harness-"));
      let manifest;
      if (bare) {
        manifest = {
          manifest_version: 2,
          name: "yapsum-harness",
          version: "0.0.1",
          browser_specific_settings: { gecko: { id: "yapsum-harness@test" } },
          permissions: [
            "tabs",
            "https://www.youtube.com/*",
            "https://m.youtube.com/*",
            "http://127.0.0.1/*",
            ...(observe.length ? ["webRequest", "webRequestBlocking"] : []),
          ],
          background: { scripts: ["harness-bg.js"], persistent: true },
          content_scripts: [{ matches: contentMatches, js: ["harness-content.js"], run_at: "document_idle" }],
        };
      } else {
        cpSync(srcDir || join(ROOT, "src"), extDir, { recursive: true });
        manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
        manifest.permissions = [...new Set([...(manifest.permissions || []), "tabs", "http://127.0.0.1/*"])];
        manifest.background.scripts = [...manifest.background.scripts, "harness-bg.js"];
        manifest.content_scripts = [
          ...manifest.content_scripts,
          { matches: contentMatches, js: ["harness-content.js"], run_at: "document_idle" },
        ];
      }
      writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest, null, 1));
      writeFileSync(join(extDir, "harness-bg.js"), buildBackground({ port: api.port, observe, closeExistingTabs, extra: bg }));
      writeFileSync(join(extDir, "harness-content.js"), buildContent({ port: api.port, extra: content }));
      return extDir;
    },

    async start({ startUrl = null, timeoutMs = 120000 } = {}) {
      if (!api.port) await api.listen();
      if (!extDir) api.build();
      const args = ["run", "--source-dir", extDir, "--no-reload", "--no-input"];
      if (target === "android") {
        args.push("--target", "firefox-android", "--android-device", android.device(), "--firefox-apk", android.FIREFOX_APK);
      } else {
        profileDir = mkdtempSync(join(tmpdir(), "yapsum-ff-"));
        args.push(
          "--firefox", FIREFOX,
          "--firefox-profile", profileDir,
          "--profile-create-if-missing",
          "--pref", "app.update.disabledForTesting=true"
        );
        if (startUrl) args.push("--start-url", startUrl);
        if (headless) args.push("--arg=-headless");
      }
      child = spawn("web-ext", args, { cwd: ROOT, stdio: ["ignore", "pipe", DEBUG ? "inherit" : "ignore"] });
      let buf = "";
      child.stdout.on("data", (c) => {
        buf += c;
        if (DEBUG) process.stdout.write(c);
        if (/Installed .* as a temporary add-on/.test(buf)) installed = true;
      });
      const ok = await api.waitFor(() => installed, timeoutMs, "extension install");
      if (!ok) throw new Error("web-ext never reported a temporary add-on install");
      if (target === "android") {
        await sleep(2500);
        const dismissed = android.dismissDialogs();
        if (DEBUG && dismissed.length) console.log("  [dialogs]", dismissed.join(", "));
      }
      await api.waitFor(() => api.last("harness-bg-ready"), 30000, "harness background ready");
      return api;
    },

    async open(videoId, { path = "watch", fresh = true } = {}) {
      const host = site === "mweb" ? "m.youtube.com" : "www.youtube.com";
      if (target === "android" && fresh) await api.call("closeYouTubeTabs", null, { scope: "bg", timeoutMs: 15000 });
      const nonce = fresh ? `${path === "shorts" ? "?" : "&"}yapsumrun=${++openSeq}` : "";
      const url =
        path === "shorts"
          ? `https://${host}/shorts/${videoId}${nonce}`
          : `https://${host}/watch?v=${videoId}${nonce}`;
      if (target === "android") android.viewIntent(url);
      return url;
    },

    async call(kind, payload, { match, scope = "content", timeoutMs = 20000 } = {}) {
      const id = ++cmdSeq;
      cmdQueue.push({ id, kind, payload: payload || null, match: match || null, scope });
      const ok = await api.waitFor(() => results.has(id), timeoutMs, `command ${kind}`);
      if (!ok) {
        const idx = cmdQueue.findIndex((c) => c.id === id);
        if (idx !== -1) cmdQueue.splice(idx, 1);
        return { __timeout: true };
      }
      const r = results.get(id);
      return r.error ? { err: r.error } : r.value;
    },

    async waitFor(pred, timeoutMs, label) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        let v = null;
        try { v = await pred(); } catch { v = null; }
        if (v) return v;
        await sleep(300);
      }
      if (DEBUG && label) console.log(`  [timeout] ${label} after ${timeoutMs}ms`);
      return null;
    },

    since(kind, afterIndex = 0) {
      return events.filter((e, i) => i >= afterIndex && e.kind === kind);
    },

    last(kind) {
      for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === kind) return events[i];
      return null;
    },

    mark() {
      return events.length;
    },

    netSince(index, pred) {
      return events
        .filter((e, i) => i >= index && (e.kind === "net-request" || e.kind === "net-body"))
        .filter((e) => (pred ? pred(e) : true));
    },

    screenshot(name) {
      if (target !== "android") return null;
      mkdirSync(artifacts, { recursive: true });
      try { return android.screencap(join(artifacts, `${name}.png`)); } catch { return null; }
    },

    async stop() {
      try { if (child) child.kill("SIGTERM"); } catch {}
      await sleep(400);
      try { if (child) child.kill("SIGKILL"); } catch {}
      try { server.close(); } catch {}
      if (target === "desktop") {
        try { execFileSync("/bin/sh", ["-c", `pkill -f 'firefox.*-profile ${tmpdir()}'; true`]); } catch {}
      }
      for (const dir of [extDir, profileDir]) {
        if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
      }
    },
  };

  return api;
}
