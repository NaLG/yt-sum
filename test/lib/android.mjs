import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const ANDROID_HOME = process.env.ANDROID_HOME || "/opt/homebrew/share/android-commandlinetools";
const JAVA_HOME = process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home";
const ADB = `${ANDROID_HOME}/platform-tools/adb`;
export const FIREFOX_APK = process.env.YAPSUM_FIREFOX_APK || "org.mozilla.firefox";

export function adbPath() {
  if (!existsSync(ADB)) throw new Error(`SDK adb not found at ${ADB}; see scripts/android-env.sh`);
  return ADB;
}

export function adb(...args) {
  const opts = typeof args[args.length - 1] === "object" ? args.pop() : {};
  return execFileSync(adbPath(), args, {
    encoding: opts.binary ? "buffer" : "utf8",
    maxBuffer: opts.maxBuffer || 64 * 1024 * 1024,
    timeout: opts.timeout || 60000,
  });
}

export function adbTry(...args) {
  try { return adb(...args); } catch { return null; }
}

export function devices() {
  return adb("devices")
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter(([, s]) => s === "device")
    .map(([id]) => id);
}

export function device() {
  const ids = devices();
  if (!ids.length) throw new Error("no authorized Android device; run: npm run emulator");
  return ids[0];
}

export function booted() {
  return (adbTry("shell", "getprop", "sys.boot_completed") || "").trim() === "1";
}

export function ensureEmulator({ root = new URL("../..", import.meta.url).pathname } = {}) {
  if (devices().length && booted()) return { started: false };
  const r = spawnSync("/bin/sh", [`${root}/scripts/android-emulator.sh`, "up"], {
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    env: { ...process.env, ANDROID_HOME, JAVA_HOME, PATH: `${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${ANDROID_HOME}/cmdline-tools/latest/bin:${JAVA_HOME}/bin:${process.env.PATH}` },
  });
  if (r.status !== 0) throw new Error(`emulator boot failed: ${(r.stderr || r.stdout || "").slice(-400)}`);
  return { started: true };
}

export function reversePort(port) {
  adb("reverse", `tcp:${port}`, `tcp:${port}`);
}

export function unreversePort(port) {
  adbTry("reverse", "--remove", `tcp:${port}`);
}

export function clearReverses() {
  const before = (adbTry("reverse", "--list") || "").split("\n").filter(Boolean).length;
  adbTry("reverse", "--remove-all");
  return before;
}

export function viewIntent(url) {
  adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${url.replace(/'/g, "")}'`, FIREFOX_APK);
}

export function forceStop() {
  adbTry("shell", "am", "force-stop", FIREFOX_APK);
}

export function screencap(filePath) {
  const buf = adb("exec-out", "screencap", "-p", { binary: true });
  writeFileSync(filePath, buf);
  return filePath;
}

const NODE_RE = /<node[^>]*\/?>/g;
const ATTR_RE = /([a-z-]+)="([^"]*)"/g;

export function uiDump({ retries = 3 } = {}) {
  for (let i = 0; i < retries; i++) {
    const dumped = adbTry("shell", "uiautomator", "dump", "/sdcard/yapsum-ui.xml");
    if (dumped === null) continue;
    const xml = adbTry("shell", "cat", "/sdcard/yapsum-ui.xml");
    if (!xml) continue;
    const nodes = [];
    for (const tag of xml.match(NODE_RE) || []) {
      const attrs = {};
      let m;
      ATTR_RE.lastIndex = 0;
      while ((m = ATTR_RE.exec(tag))) attrs[m[1]] = m[2];
      const b = (attrs.bounds || "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!b) continue;
      const x1 = +b[1], y1 = +b[2], x2 = +b[3], y2 = +b[4];
      nodes.push({
        text: attrs.text || "",
        desc: attrs["content-desc"] || "",
        id: attrs["resource-id"] || "",
        cls: attrs.class || "",
        pkg: attrs.package || "",
        clickable: attrs.clickable === "true",
        bounds: { x1, y1, x2, y2 },
        cx: Math.round((x1 + x2) / 2),
        cy: Math.round((y1 + y2) / 2),
        w: x2 - x1,
        h: y2 - y1,
      });
    }
    if (nodes.length) return nodes;
  }
  return [];
}

export function findNode(pred, nodes) {
  return (nodes || uiDump()).find(pred) || null;
}

export function tapPoint(x, y) {
  adb("shell", "input", "swipe", String(x), String(y), String(x + 1), String(y), "60");
}

export function tapNode(node) {
  if (!node) return false;
  tapPoint(node.cx, node.cy);
  return true;
}

const DISMISS_LABELS = [/^don.?t allow$/i, /^not now$/i, /^no thanks$/i, /^dismiss$/i, /^close$/i, /^cancel$/i];
const ADDON_DIALOG = /was added|permissions and data preferences|added to firefox/i;

export function dismissDialogs({ rounds = 4 } = {}) {
  const dismissed = [];
  for (let i = 0; i < rounds; i++) {
    const nodes = uiDump();
    const hit = nodes.find((n) => n.clickable && DISMISS_LABELS.some((re) => re.test(n.text.trim())));
    if (hit) {
      tapNode(hit);
      dismissed.push(hit.text.trim());
      continue;
    }
    const addonDialog = nodes.some((n) => ADDON_DIALOG.test(n.text));
    if (addonDialog) {
      const ok =
        nodes.find((n) => n.clickable && /confirm_button$/.test(n.id)) ||
        nodes.find((n) => n.clickable && /^(ok|got it|continue)$/i.test(n.text.trim()));
      if (ok) {
        tapNode(ok);
        dismissed.push(`addon-dialog:${ok.text.trim() || "confirm"}`);
        continue;
      }
    }
    break;
  }
  return dismissed;
}

export function playerNode(nodes) {
  const all = nodes || uiDump();
  return (
    all.find((n) => n.id.includes("movie_player") && n.w > 200 && n.h > 100) ||
    all.find((n) => /player/i.test(n.id) && n.clickable && n.w > 200 && n.h > 100) ||
    all.find((n) => /video player/i.test(n.text) && n.w > 200) ||
    null
  );
}

export function tapPlay(attempt = 0) {
  dismissDialogs();
  const nodes = uiDump();
  const playBtn = nodes.find(
    (n) => /^play$/i.test(n.text.trim()) || /^play$/i.test(n.desc.trim()) || /play video/i.test(n.desc)
  );
  if (playBtn && attempt < 3) {
    tapNode(playBtn);
    return { via: "play-node", at: { x: playBtn.cx, y: playBtn.cy } };
  }
  const p = playerNode(nodes);
  if (p) {
    const y = attempt % 2 === 0 ? p.cy : p.y1 + Math.round(p.h * 0.35);
    tapPoint(p.cx, y);
    return { via: "player-node", at: { x: p.cx, y } };
  }
  const y = [520, 430, 610, 700, 480][attempt % 5];
  tapPoint(540, y);
  return { via: "coords", at: { x: 540, y } };
}

export function geckoProfileDir() {
  const out = adbTry("shell", "ls", "/data/data/org.mozilla.firefox/files/mozilla/");
  if (!out) return null;
  const dir = out.split("\n").map((l) => l.trim()).find((l) => l.endsWith(".default"));
  return dir ? `/data/data/org.mozilla.firefox/files/mozilla/${dir}` : null;
}

export function rootShell() {
  adbTry("root");
  return true;
}

export function setDesktopUa(enabled, { ua } = {}) {
  rootShell();
  const profile = geckoProfileDir();
  if (!profile) throw new Error("gecko profile not found; is Firefox installed and run once?");
  const value = ua || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0";
  adb("shell", `sed -i '/useragent.override/d' ${profile}/user.js ${profile}/prefs.js 2>/dev/null; true`);
  if (enabled) {
    adb("shell", `echo 'user_pref("general.useragent.override", "${value}");' >> ${profile}/user.js`);
  }
  forceStop();
  const left = adbTry("shell", `grep -c useragent.override ${profile}/user.js ${profile}/prefs.js 2>/dev/null; true`) || "";
  return { profile, enabled, residual: left.trim() };
}

export function setPrefs(prefs) {
  rootShell();
  const profile = geckoProfileDir();
  if (!profile) throw new Error("gecko profile not found");
  const keys = Object.keys(prefs);
  if (keys.length) {
    const escaped = keys.map((k) => k.replace(/\./g, "\\.")).join("\\|");
    adb("shell", `sed -i '/${escaped}/d' ${profile}/user.js ${profile}/prefs.js 2>/dev/null; true`);
  }
  for (const [k, v] of Object.entries(prefs)) {
    const val = typeof v === "string" ? `"${v}"` : String(v);
    adb("shell", `echo 'user_pref("${k}", ${val});' >> ${profile}/user.js`);
  }
  forceStop();
  return { profile, applied: prefs };
}

export function clearPrefs(keys) {
  rootShell();
  const profile = geckoProfileDir();
  if (!profile || !keys.length) return null;
  const escaped = keys.map((k) => k.replace(/\./g, "\\.")).join("\\|");
  adb("shell", `sed -i '/${escaped}/d' ${profile}/user.js ${profile}/prefs.js 2>/dev/null; true`);
  forceStop();
  return { profile, cleared: keys };
}

export function findByText(re, nodes) {
  const all = nodes || uiDump();
  return all.find((n) => n.clickable && (re.test(n.text.trim()) || re.test(n.desc.trim()))) ||
    all.find((n) => re.test(n.text.trim()) || re.test(n.desc.trim())) || null;
}

export function captionPrefSummary() {
  const profile = geckoProfileDir();
  if (!profile) return null;
  return adbTry("shell", `grep -o 'yt-player-headers-readable[^;]*' ${profile}/prefs.js 2>/dev/null; true`);
}
