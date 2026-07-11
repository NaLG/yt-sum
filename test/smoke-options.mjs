#!/usr/bin/env node
// Test the options page IN the extension context (geckodriver — no YouTube here,
// so automation isn't blocked). Verifies the two things the user hit:
//   1. Preset chips render and clicking one fills the base URL.
//   2. The model <select> dropdown populates, and picking an option fills the
//      model text input.
// A fixed moz-extension UUID (set via the uuids pref) lets us navigate straight
// to the options page.

import { spawn, execSync as sh } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const PORT = 4470;
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const SRC = new URL("../src", import.meta.url).pathname;
const UUID = "11111111-1111-1111-1111-111111111111";
// Read the id from the manifest so id changes can't silently break the UUID pin.
const ADDON_ID = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url), "utf8"))
  .browser_specific_settings.gecko.id;

const base = `http://127.0.0.1:${PORT}`;
async function wd(method, path, body) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  if (data.value && data.value.error) throw new Error(`${path}: ${data.value.error} ${data.value.message || ""}`);
  return data.value;
}
async function ready(ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await wd("GET", "/status")).ready) return; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("geckodriver not ready");
}
const ex = (sid, script, args = []) => wd("POST", `/session/${sid}/execute/sync`, { script, args });

const zipPath = join(mkdtempSync(join(tmpdir(), "yapsum-zip-")), "ext.zip");
sh(`cd "${SRC}" && zip -qr "${zipPath}" .`);
const addonB64 = readFileSync(zipPath).toString("base64");

const driver = spawn("geckodriver", ["-p", String(PORT)], { stdio: "ignore" });
let sid, failures = 0;
const check = (name, ok, detail = "") => { console.log((ok ? "✓ " : "✗ ") + name + (detail ? "  " + detail : "")); if (!ok) failures++; };

try {
  await ready();
  ({ sessionId: sid } = await wd("POST", "/session", {
    capabilities: { alwaysMatch: {
      browserName: "firefox",
      "moz:firefoxOptions": {
        binary: FIREFOX,
        args: ["-headless", "--no-remote", "--new-instance"],
        // Pin the extension's internal UUID so we can navigate to its options
        // page, and auto-accept optional-permission requests so the runtime
        // host-grant flow (ensureHostPermission) is testable end to end.
        prefs: {
          "extensions.webextensions.uuids": JSON.stringify({ [ADDON_ID]: UUID }),
          "extensions.webextOptionalPermissionPrompts": false,
        },
      },
      timeouts: { script: 20000, pageLoad: 30000 },
    } },
  }));
  await wd("POST", `/session/${sid}/moz/addon/install`, { addon: addonB64, temporary: true });
  await wd("POST", `/session/${sid}/url`, { url: `moz-extension://${UUID}/options/options.html` });
  // Let load()/renderPresets() run.
  await new Promise((r) => setTimeout(r, 1500));

  const state = await ex(sid, `return {
    title: document.title,
    presetCount: document.querySelectorAll('#presetChips .preset-chip').length,
    hasSelect: !!document.getElementById('modelSelect'),
    modelOptions: document.getElementById('modelSelect') ? document.getElementById('modelSelect').options.length : 0,
  };`);
  check("options page loaded", /return youtube summary/i.test(state.title || ""), `title="${state.title}"`);
  check("preset chips render", state.presetCount >= 5, `count=${state.presetCount}`);
  check("model dropdown is a <select>", state.hasSelect);
  check("model dropdown pre-seeded", state.modelOptions >= 3, `options=${state.modelOptions}`);

  // Click the OpenRouter preset → base URL fills.
  const afterPreset = await ex(sid, `
    const chip = [...document.querySelectorAll('#presetChips .preset-chip')].find(b => /openrouter/i.test(b.textContent));
    if (chip) chip.click();
    return { baseUrl: document.getElementById('baseUrl').value, model: document.getElementById('model').value };
  `);
  check("clicking OpenRouter preset fills base URL", afterPreset.baseUrl === "https://openrouter.ai/api/v1", `baseUrl="${afterPreset.baseUrl}"`);
  check("preset also fills a default model", !!afterPreset.model, `model="${afterPreset.model}"`);

  // Pick a model from the dropdown → text input updates.
  const afterPick = await ex(sid, `
    const sel = document.getElementById('modelSelect');
    // choose the first real model option (index 1; 0 is placeholder)
    const opt = [...sel.options].find(o => o.value && o.value !== '__custom__');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));
    return { picked: opt.value, model: document.getElementById('model').value };
  `);
  check("picking from dropdown fills model field", afterPick.model === afterPick.picked, `picked="${afterPick.picked}" model="${afterPick.model}"`);

  // API key field is readable by default; the toggle masks/reveals it.
  const keyState = await ex(sid, `
    const el = document.getElementById('apiKey');
    const before = el.type;
    document.getElementById('toggleKey').click();
    const after = el.type;
    document.getElementById('toggleKey').click();
    return { before, after, restored: el.type, btn: document.getElementById('toggleKey').textContent };
  `);
  check("API key visible by default", keyState.before === "text", `type="${keyState.before}"`);
  check("toggle masks the key", keyState.after === "password");
  check("toggle restores visibility", keyState.restored === "text");

  // Provider hosts are OPTIONAL permissions: Save must runtime-request the
  // one host for the configured endpoint (auto-granted via the pref above)
  // and end in "Saved.", proving the least-privilege grant flow works.
  // permissions.request demands a USER INPUT handler, so the click must be a
  // trusted WebDriver element click, not a synthetic executeScript .click().
  await ex(sid, `document.getElementById('apiKey').value = 'sk-smoke-test';`);
  const found = await wd("POST", `/session/${sid}/element`, { using: "css selector", value: "#save" });
  const eid = Object.values(found)[0];
  await wd("POST", `/session/${sid}/element/${eid}/click`, {});
  let saveStatus = "";
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    saveStatus = (await ex(sid, `return document.getElementById('status').textContent;`)) || "";
    if (saveStatus) break;
  }
  check("save runtime-grants the provider host", /^saved\.?$/i.test(saveStatus.trim()), `status="${saveStatus}"`);
  const granted = await ex(sid, `return browser.permissions.contains({ origins: ["https://openrouter.ai/*"] });`).catch(() => null);
  check("openrouter.ai origin granted after save", granted === true, `contains=${granted}`);
} catch (e) {
  console.log("SMOKE ERROR:", e.message);
  failures++;
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
  driver.kill();
}
console.log(failures ? `\n❌ ${failures} check(s) failed` : "\n✅ options page OK");
process.exit(failures ? 1 : 0);
