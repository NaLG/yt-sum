#!/usr/bin/env node
import { spawn, execSync as sh, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const mock = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock/alpha" }, { id: "mock/beta" }] }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
const MOCKPORT = await new Promise((r) => mock.listen(0, "127.0.0.1", () => r(mock.address().port)));

const PORT = 4470;
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const SRC = new URL("../src", import.meta.url).pathname;
const UUID = "11111111-1111-1111-1111-111111111111";
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
        prefs: {
          "extensions.webextensions.uuids": JSON.stringify({ [ADDON_ID]: UUID }),
          "extensions.webextOptionalPermissionPrompts": false,
          "app.update.disabledForTesting": true,
        },
      },
      timeouts: { script: 20000, pageLoad: 30000 },
    } },
  }));
  await wd("POST", `/session/${sid}/moz/addon/install`, { addon: addonB64, temporary: true });
  await wd("POST", `/session/${sid}/url`, { url: `moz-extension://${UUID}/options/options.html` });
  await new Promise((r) => setTimeout(r, 1500));

  const state = await ex(sid, `
    const m = document.getElementById('model');
    m.focus();
    m.value = ''; // an empty field shows the whole catalog
    m.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      title: document.title,
      presetCount: document.querySelectorAll('#presetChips .preset-chip').length,
      comboOptions: m.parentNode.querySelectorAll('.combo-opt').length,
    };`);
  check("options page loaded", /return youtube summary/i.test(state.title || ""), `title="${state.title}"`);
  check("preset chips render", state.presetCount >= 5, `count=${state.presetCount}`);
  check("model combobox opens pre-seeded on focus", state.comboOptions >= 3, `options=${state.comboOptions}`);

  const afterPreset = await ex(sid, `
    const chip = [...document.querySelectorAll('#presetChips .preset-chip')].find(b => /openrouter/i.test(b.textContent));
    if (chip) chip.click();
    return { baseUrl: document.getElementById('baseUrl').value, model: document.getElementById('model').value, label: document.getElementById('label').value };
  `);
  check("clicking OpenRouter preset fills base URL", afterPreset.baseUrl === "https://openrouter.ai/api/v1", `baseUrl="${afterPreset.baseUrl}"`);
  check("preset also fills a default model", !!afterPreset.model, `model="${afterPreset.model}"`);
  check("default-model label auto-fills from model id", afterPreset.label === "gemini-3.5-flash", `label="${afterPreset.label}"`);

  const afterFilter = await ex(sid, `
    const m = document.getElementById('model');
    m.focus();
    m.value = 'glm';
    m.dispatchEvent(new Event('input', { bubbles: true }));
    return [...m.parentNode.querySelectorAll('.combo-opt')].map(o => o.textContent);
  `);
  check(
    "typing filters and ranks substring hits first",
    afterFilter.length >= 2 && /glm/i.test(afterFilter[0]) && /glm/i.test(afterFilter[1]),
    JSON.stringify(afterFilter)
  );
  const afterPick = await ex(sid, `
    const m = document.getElementById('model');
    const opt = m.parentNode.querySelector('.combo-opt');
    const picked = opt.textContent;
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return { picked, model: m.value, listHidden: m.parentNode.querySelector('.combo-list').hidden };
  `);
  check("picking a suggestion fills model field", afterPick.model === afterPick.picked, `picked="${afterPick.picked}" model="${afterPick.model}"`);
  check("picking closes the list", afterPick.listHidden === true);

  const splitSearch = await ex(sid, `
    const m = document.getElementById('model');
    m.focus();
    m.value = 'gemini35';
    m.dispatchEvent(new Event('input', { bubbles: true }));
    const opts = [...m.parentNode.querySelectorAll('.combo-opt')].map(o => o.textContent);
    m.value = 'google/gemini-3.5-flash';
    m.dispatchEvent(new Event('input', { bubbles: true }));
    return opts;
  `);
  check(
    "split query matches across separators (gemini35)",
    splitSearch.length === 1 && splitSearch[0] === "google/gemini-3.5-flash",
    JSON.stringify(splitSearch)
  );

  const keyState = await ex(sid, `
    const el = document.getElementById('apiKey');
    const before = el.type;
    document.getElementById('toggleKey').click();
    const after = el.type;
    document.getElementById('toggleKey').click();
    return { before, after, restored: el.type, btn: document.getElementById('toggleKey').textContent };
  `);
  const autoSum = await ex(sid, `return document.getElementById('autoSummarize').checked;`);
  check("auto-summarize checked by default", autoSum === true, `checked=${autoSum}`);
  check("API key visible by default", keyState.before === "text", `type="${keyState.before}"`);
  check("toggle masks the key", keyState.after === "password");
  check("toggle restores visibility", keyState.restored === "text");

  await ex(sid, `document.getElementById('apiKey').value = 'sk-smoke-test';`);
  const rowState = await ex(sid, `
    document.getElementById('addModel').click();
    const row = document.querySelector('#extraModelsList .xm-row');
    const m = row.querySelector('.xm-model');
    m.focus();
    m.value = 'glm';
    m.dispatchEvent(new Event('input', { bubbles: true }));
    const filtered = [...row.querySelectorAll('.combo-opt')].map(o => o.textContent);
    m.value = 'moonshotai/kimi-k3';
    m.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      label: row.querySelector('.xm-label').value,
      key: row.querySelector('.xm-apiKey').value,
      baseUrl: row.querySelector('.xm-baseUrl').value,
      filtered,
    };
  `);
  check("row label auto-fills from model id", rowState.label === "kimi-k3", `label="${rowState.label}"`);
  check("row key prefilled from main key", rowState.key === "sk-smoke-test", `key="${rowState.key}"`);
  check("row endpoint prefilled from main", rowState.baseUrl === "https://openrouter.ai/api/v1", `baseUrl="${rowState.baseUrl}"`);
  check(
    "row combobox filters over the shared catalog, ranked",
    rowState.filtered.length >= 2 && /glm/i.test(rowState.filtered[0]) && /glm/i.test(rowState.filtered[1]),
    JSON.stringify(rowState.filtered)
  );

  await ex(sid, `
    const row = document.querySelector('#extraModelsList .xm-row');
    row.querySelector('.xm-baseUrl').value = 'http://127.0.0.1:${MOCKPORT}/v1';
    row.querySelector('.xm-apiKey').value = 'k2';
  `);
  const loadEl = await wd("POST", `/session/${sid}/element`, { using: "css selector", value: "#extraModelsList .xm-row .xm-load" });
  await wd("POST", `/session/${sid}/element/${Object.values(loadEl)[0]}/click`, {});
  let rowList = [];
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 400));
    rowList = await ex(sid, `
      const row = document.querySelector('#extraModelsList .xm-row');
      const m = row.querySelector('.xm-model');
      m.focus();
      m.value = '';
      m.dispatchEvent(new Event('input', { bubbles: true }));
      return [...row.querySelectorAll('.combo-opt')].map(o => o.textContent);
    `);
    if (rowList.includes("mock/alpha")) break;
  }
  check("row loader pulls the row endpoint's catalog", rowList.includes("mock/alpha") && rowList.includes("mock/beta"), JSON.stringify(rowList));
  const mainList = await ex(sid, `
    const m = document.getElementById('model');
    m.focus();
    m.value = '';
    m.dispatchEvent(new Event('input', { bubbles: true }));
    const all = [...m.parentNode.querySelectorAll('.combo-opt')].map(o => o.textContent);
    m.value = 'google/gemini-3.5-flash'; // restore for the save test below
    m.dispatchEvent(new Event('input', { bubbles: true }));
    // Restore the row's model too: the save test below must persist a REAL,
    // complete entry (the shape smoke-full replays against the panel).
    const rm = document.querySelector('#extraModelsList .xm-row .xm-model');
    rm.value = 'moonshotai/kimi-k3';
    rm.dispatchEvent(new Event('input', { bubbles: true }));
    return all;
  `);
  check("row catalog stays row-local", mainList.length >= 3 && !mainList.includes("mock/alpha"), `main sees ${mainList.length} options`);

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

  const stored = await ex(sid, `return browser.storage.local.get("extraModels");`).catch(() => null);
  const xm = stored?.extraModels?.[0];
  check(
    "options-UI save persists the full extraModels entry",
    !!xm && typeof xm.id === "string" && xm.id.length >= 2 && xm.label === "kimi-k3" && xm.provider === "openai" &&
      xm.baseUrl === `http://127.0.0.1:${MOCKPORT}/v1` && xm.model === "moonshotai/kimi-k3" && xm.apiKey === "k2",
    JSON.stringify(stored?.extraModels)
  );

  await ex(sid, `
    document.getElementById('addModel').click();
    const rows = document.querySelectorAll('#extraModelsList .xm-row');
    const row = rows[rows.length - 1];
    const l = row.querySelector('.xm-label');
    l.value = 'typed-into-wrong-field';
    l.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await wd("POST", `/session/${sid}/element/${eid}/click`, {});
  let badStatus = "";
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 400));
    badStatus = (await ex(sid, `return document.getElementById('status').textContent;`)) || "";
    if (badStatus && !/^saved\.?$/i.test(badStatus.trim())) break;
  }
  check("label-without-model row refuses to save", /no model id/i.test(badStatus), `status="${badStatus}"`);

  await wd("POST", `/session/${sid}/window/rect`, { width: 420, height: 900 });
  await new Promise((r) => setTimeout(r, 300));
  const narrow = await ex(sid, `
    const label = document.getElementById('label');
    const model = document.getElementById('model');
    const row = label.closest('.model-row');
    return {
      rowW: Math.round(row.getBoundingClientRect().width),
      labelW: Math.round(label.getBoundingClientRect().width),
      modelW: Math.round(model.getBoundingClientRect().width),
    };
  `);
  check(
    "narrow viewport stacks label and model fields",
    narrow.labelW > narrow.rowW * 0.9 && narrow.modelW > narrow.rowW * 0.55,
    JSON.stringify(narrow)
  );
  await ex(sid, `document.getElementById('label').scrollIntoView({ block: 'center' });`);
  const shot = await wd("GET", `/session/${sid}/screenshot`);
  const artifacts = new URL("./artifacts", import.meta.url).pathname;
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(`${artifacts}/options-narrow.png`, Buffer.from(shot, "base64"));
} catch (e) {
  console.log("SMOKE ERROR:", e.message);
  failures++;
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
  driver.kill();
  mock.close();
  try { execFileSync("/bin/sh", ["-c", `sleep 2; pkill -f 'firefox.*-profile ${tmpdir()}'; true`]); } catch {}
}
console.log(failures ? `\n❌ ${failures} check(s) failed` : "\n✅ options page OK");
process.exit(failures ? 1 : 0);
