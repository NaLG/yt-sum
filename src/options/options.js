const FIELDS = ["provider", "baseUrl", "model", "label", "apiKey", "systemPrompt", "maxTokens", "maxTranscriptChars"];
const $ = (id) => document.getElementById(id);

let DEFAULTS = null;

const PRESETS = [
  { label: "OpenRouter", provider: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-3.5-flash" },
  { label: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "Google Gemini", provider: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-flash-latest" },
  { label: "GLM / Z.ai", provider: "openai", baseUrl: "https://api.z.ai/api/paas/v4", model: "glm-4.7-flash" },
  { label: "Groq", provider: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "" },
  { label: "Ollama (local)", provider: "openai", baseUrl: "http://localhost:11434/v1", model: "llama3.2" },
  { label: "LM Studio (local)", provider: "openai", baseUrl: "http://localhost:1234/v1", model: "" },
  { label: "Anthropic (Claude)", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-fable-5" },
];

function renderPresets() {
  const wrap = $("presetChips");
  wrap.innerHTML = "";
  PRESETS.forEach((p, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "preset-chip";
    b.textContent = p.label;
    b.title = p.baseUrl;
    b.addEventListener("click", () => applyPreset(i));
    wrap.appendChild(b);
  });
}

function applyPreset(i) {
  const p = PRESETS[i];
  $("provider").value = p.provider;
  $("baseUrl").value = p.baseUrl;
  if (p.model) $("model").value = p.model;
  syncMainLabel();
  fillModelList(FALLBACK_MODELS[p.provider] || []);
  setStatus(`Filled ${p.label}. Add your API key, then Save (or Load models to pick one).`, "ok");
}

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + kind;
}

const FALLBACK_MODELS = {
  openai: [
    "google/gemini-3.5-flash",
    "z-ai/glm-5.2",
    "google/gemini-3.1-flash-lite",
    "z-ai/glm-4.7-flash",
    "openai/gpt-5-mini",
    "anthropic/claude-haiku-4.5",
    "gpt-4o-mini",
  ],
  anthropic: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
};

let currentModelIds = [];
const modelCombos = new Set();
function fillModelList(ids) {
  currentModelIds = ids.slice();
  for (const c of modelCombos) c.refresh();
}

function makeCombobox(input, getOptions) {
  const wrap = document.createElement("span");
  wrap.className = "combo";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const list = document.createElement("div");
  list.className = "combo-list";
  list.hidden = true;
  wrap.appendChild(list);
  let items = [];
  let sel = -1;

  function matchRank(q, id) {
    const hay = id.toLowerCase();
    if (hay.includes(q)) return 0;
    let from = 0;
    for (const ch of q) {
      if (!/[a-z0-9]/.test(ch)) continue;
      const at = hay.indexOf(ch, from);
      if (at === -1) return -1;
      from = at + 1;
    }
    return 1;
  }

  function render() {
    if (document.activeElement !== input) { list.hidden = true; return; }
    const q = input.value.trim().toLowerCase();
    const opts = getOptions();
    if (q) {
      const ranked = [];
      for (const o of opts) {
        const rank = matchRank(q, o);
        if (rank >= 0) ranked.push([rank, o]);
      }
      ranked.sort((a, b) => a[0] - b[0]);
      items = ranked.map((r) => r[1]);
    } else {
      items = opts;
    }
    list.innerHTML = "";
    sel = -1;
    for (let i = 0; i < items.length; i++) {
      const el = document.createElement("div");
      el.className = "combo-opt";
      el.textContent = items[i];
      el.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); });
      list.appendChild(el);
    }
    list.hidden = !items.length;
  }
  function pick(i) {
    if (items[i] == null) return;
    input.value = items[i];
    input.dispatchEvent(new Event("input", { bubbles: true }));
    list.hidden = true;
  }
  function move(d) {
    if (list.hidden) { render(); return; }
    sel = Math.max(0, Math.min(items.length - 1, sel + d));
    [...list.children].forEach((el, i) => el.classList.toggle("combo-sel", i === sel));
    if (list.children[sel]) list.children[sel].scrollIntoView({ block: "nearest" });
  }
  input.addEventListener("focus", render);
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && !list.hidden && sel >= 0) { e.preventDefault(); pick(sel); }
    else if (e.key === "Escape") { list.hidden = true; }
  });
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 120));
  return { refresh: render };
}

function shortLabel(modelId) {
  return (modelId || "").split("/").pop();
}

let mainLabelAuto = true;
function syncMainLabel() {
  if (mainLabelAuto) $("label").value = shortLabel($("model").value);
}

function addModelRow(entry) {
  const row = document.createElement("div");
  row.className = "xm-row";
  row.dataset.id = entry?.id || "m" + Math.random().toString(36).slice(2, 8);
  row.dataset.autoLabel = entry && entry.label && entry.label !== shortLabel(entry.model) ? "0" : "1";

  const top = document.createElement("div");
  top.className = "model-row";
  const label = document.createElement("input");
  label.className = "xm-label";
  label.placeholder = "label";
  label.value = entry?.label || "";
  const model = document.createElement("input");
  model.className = "xm-model";
  model.placeholder = "model id (type to filter)";
  model.spellcheck = false;
  model.value = entry?.model || "";
  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.className = "xm-load";
  loadBtn.textContent = "↻";
  loadBtn.title = "Load the model list from this row's endpoint";
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "xm-remove";
  rm.textContent = "✕";
  rm.title = "Remove this model";
  rm.addEventListener("click", () => row.remove());
  top.append(label, model, loadBtn, rm);

  const adv = document.createElement("details");
  adv.className = "xm-adv";
  const sum = document.createElement("summary");
  sum.textContent = "Endpoint & key (prefilled from your main settings)";
  const provider = document.createElement("select");
  provider.className = "xm-provider";
  for (const [v, t] of [["openai", "OpenAI-compatible"], ["anthropic", "Anthropic (Claude)"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    provider.appendChild(o);
  }
  provider.value = entry?.provider || $("provider").value;
  const baseUrl = document.createElement("input");
  baseUrl.className = "xm-baseUrl";
  baseUrl.placeholder = "API base URL";
  baseUrl.spellcheck = false;
  baseUrl.value = entry?.baseUrl || $("baseUrl").value;
  const apiKey = document.createElement("input");
  apiKey.className = "xm-apiKey";
  apiKey.placeholder = "API key for this model";
  apiKey.spellcheck = false;
  apiKey.autocomplete = "off";
  apiKey.value = entry?.apiKey || $("apiKey").value;
  adv.append(sum, provider, baseUrl, apiKey);

  model.addEventListener("input", () => {
    if (row.dataset.autoLabel === "1") label.value = shortLabel(model.value);
  });
  label.addEventListener("input", () => { row.dataset.autoLabel = "0"; });
  label.addEventListener("blur", () => {
    if (!label.value.trim()) {
      row.dataset.autoLabel = "1";
      label.value = shortLabel(model.value);
    }
  });

  let rowCatalog = null;
  modelCombos.add(makeCombobox(model, () => rowCatalog || currentModelIds));
  loadBtn.addEventListener("click", async () => {
    const bu = (baseUrl.value.trim() || $("baseUrl").value).replace(/\/$/, "");
    const key = apiKey.value.trim() || $("apiKey").value;
    if (!bu) { setStatus("This row has no endpoint (and no main base URL to fall back to).", "err"); return; }
    setStatus("Loading models for this row…", "");
    try {
      rowCatalog = await fetchModelCatalog(provider.value, bu, key);
      setStatus(`Loaded ${rowCatalog.length} models. Type in the row's model field to filter.`, "ok");
      model.focus();
    } catch (e) {
      setStatus(`Couldn't load models for this row (${e.message}).`, "err");
    }
  });

  row.append(top, adv);
  $("extraModelsList").appendChild(row);
  return row;
}

function collectExtraModels() {
  const out = [];
  for (const row of document.querySelectorAll("#extraModelsList .xm-row")) {
    const model = row.querySelector(".xm-model").value.trim();
    if (!model) continue;
    out.push({
      id: row.dataset.id,
      label: row.querySelector(".xm-label").value.trim() || shortLabel(model),
      provider: row.querySelector(".xm-provider").value,
      baseUrl: row.querySelector(".xm-baseUrl").value.trim().replace(/\/$/, ""),
      model,
      apiKey: row.querySelector(".xm-apiKey").value.trim(),
    });
  }
  return out;
}

function renderExtraModels(list) {
  $("extraModelsList").innerHTML = "";
  for (const e of list || []) addModelRow(e);
}

async function fetchModelCatalog(provider, baseUrl, apiKey) {
  await ensureHostPermission(baseUrl);
  const headers =
    provider === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }
      : apiKey
        ? { authorization: `Bearer ${apiKey}` }
        : {};
  const res = await fetch(`${baseUrl}/models`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  const json = await res.json();
  const ids = (json.data || json.models || [])
    .map((m) => m.id || m.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  if (!ids.length) throw new Error("endpoint returned no models");
  return ids;
}

async function loadModels(silent = false) {
  const provider = $("provider").value;
  const baseUrl = $("baseUrl").value.replace(/\/$/, "");
  if (!baseUrl) {
    if (!silent) setStatus("Enter a base URL first.", "err");
    return;
  }
  if (!silent) setStatus("Loading models…", "");
  try {
    fillModelList(await fetchModelCatalog(provider, baseUrl, $("apiKey").value));
    if (!silent) setStatus(`Loaded ${currentModelIds.length} models, type in the Model field to filter.`, "ok");
  } catch (e) {
    fillModelList(FALLBACK_MODELS[provider] || []);
    if (!silent) setStatus(`Couldn't load live model list (${e.message}). Showing suggestions; you can also type any id.`, "err");
  }
}

async function load() {
  DEFAULTS = await browser.runtime.sendMessage({ type: "getDefaults" }).catch(() => ({}));
  const stored = await browser.storage.local.get(FIELDS);
  const cfg = { ...DEFAULTS, ...stored };
  for (const f of FIELDS) if ($(f)) $(f).value = cfg[f];
  const { buttonStyle, shortsButton, collapseInPlace, autoSummarize } =
    await browser.storage.local.get({ buttonStyle: "text", shortsButton: false, collapseInPlace: false, autoSummarize: true });
  const styleVal = ["icon", "tldw", "sum"].includes(buttonStyle) ? buttonStyle : "text";
  const radio = document.querySelector(`input[name="buttonStyle"][value="${styleVal}"]`);
  if (radio) radio.checked = true;
  $("shortsButton").checked = !!shortsButton;
  $("collapseInPlace").checked = !!collapseInPlace;
  $("autoSummarize").checked = autoSummarize !== false;
  fillModelList(FALLBACK_MODELS[cfg.provider] || []);
  mainLabelAuto = !cfg.label || cfg.label === shortLabel(cfg.model);
  syncMainLabel();
  const { extraModels } = await browser.storage.local.get({ extraModels: [] });
  renderExtraModels(extraModels);
}

async function ensureHostPermission(baseUrl) {
  return ensureHostPermissions([baseUrl]);
}

async function ensureHostPermissions(baseUrls) {
  const origins = [];
  for (const u of baseUrls) {
    try {
      const url = new URL(u);
      const o = `${url.protocol}//${url.hostname}/*`;
      if (!origins.includes(o)) origins.push(o);
    } catch {
      throw new Error(`Not a valid URL: ${u || "(empty base URL)"}`);
    }
  }
  if (!browser.permissions.request) {
    const has = await browser.permissions.contains({ origins });
    if (has) return true;
    throw new Error(
      `This Firefox can't grant access to ${origins.join(", ")} at runtime. ` +
        `Update Firefox, or use an endpoint you've already granted.`
    );
  }
  const granted = await browser.permissions.request({ origins });
  if (!granted) throw new Error(`Permission to reach ${origins.join(", ")} was declined. Return YouTube Summary can't call that endpoint without it.`);
  return true;
}

async function save() {
  const cfg = {};
  for (const f of FIELDS) {
    let v = $(f).value;
    if (f === "maxTokens" || f === "maxTranscriptChars") v = Number(v);
    cfg[f] = v;
  }
  if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
    setStatus("Add an API key (local endpoints may not need one).", "err");
    return;
  }
  for (const row of document.querySelectorAll("#extraModelsList .xm-row")) {
    const hasModel = row.querySelector(".xm-model").value.trim();
    const labelTxt = row.querySelector(".xm-label").value.trim();
    if (!hasModel && labelTxt) {
      setStatus(`Extra-model row "${labelTxt}" has no model id. Type or pick one in the row's second field (or remove the row).`, "err");
      return;
    }
  }
  cfg.extraModels = collectExtraModels();
  for (const m of cfg.extraModels) {
    if (m.baseUrl && m.baseUrl !== cfg.baseUrl.replace(/\/$/, "") && !m.apiKey && !/localhost|127\.0\.0\.1/.test(m.baseUrl)) {
      setStatus(`Extra model "${m.label}" points at a different endpoint and needs its own API key.`, "err");
      return;
    }
  }
  try {
    await ensureHostPermissions([cfg.baseUrl, ...cfg.extraModels.map((m) => m.baseUrl).filter(Boolean)]);
  } catch (e) {
    setStatus(e.message, "err");
    return;
  }
  await browser.storage.local.set(cfg);
  setStatus("Saved.", "ok");
}

async function reset() {
  await browser.storage.local.clear();
  await load();
  setStatus("Reset to defaults. Click Save to keep.", "");
}

async function testConnection() {
  const provider = $("provider").value;
  const baseUrl = $("baseUrl").value.replace(/\/$/, "");
  const model = $("model").value;
  const apiKey = $("apiKey").value;
  setStatus("Testing…", "");
  try {
    await ensureHostPermission(baseUrl);
    let url, headers, body;
    if (provider === "anthropic") {
      url = `${baseUrl}/messages`;
      headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
      body = { model, max_tokens: 16, messages: [{ role: "user", content: "Reply with OK." }] };
    } else {
      url = `${baseUrl}/chat/completions`;
      headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
      body = { model, max_tokens: 16, messages: [{ role: "user", content: "Reply with OK." }] };
    }
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.ok) setStatus("Connection OK, endpoint and key work.", "ok");
    else setStatus(`Endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`, "err");
  } catch (e) {
    setStatus(`Failed: ${e.message}`, "err");
  }
}

$("provider").addEventListener("change", () => {
  fillModelList(FALLBACK_MODELS[$("provider").value] || []);
});
modelCombos.add(makeCombobox($("model"), () => currentModelIds));
$("model").addEventListener("input", syncMainLabel);
$("label").addEventListener("input", () => { mainLabelAuto = false; });
$("label").addEventListener("blur", () => {
  if (!$("label").value.trim()) {
    mainLabelAuto = true;
    syncMainLabel();
  }
});
$("loadModels").addEventListener("click", () => loadModels(false));
$("addModel").addEventListener("click", () => {
  addModelRow(null).querySelector(".xm-model").focus();
});
$("save").addEventListener("click", save);
$("reset").addEventListener("click", reset);
for (const r of document.querySelectorAll('input[name="buttonStyle"]')) {
  r.addEventListener("change", async () => {
    await browser.storage.local.set({ buttonStyle: ["icon", "tldw", "sum"].includes(r.value) ? r.value : "text" });
    setStatus("Button style saved.", "ok");
  });
}
$("shortsButton").addEventListener("change", async () => {
  await browser.storage.local.set({ shortsButton: $("shortsButton").checked });
  setStatus($("shortsButton").checked ? "Shorts button on." : "Shorts button off.", "ok");
});
$("collapseInPlace").addEventListener("change", async () => {
  await browser.storage.local.set({ collapseInPlace: $("collapseInPlace").checked });
  setStatus($("collapseInPlace").checked ? "Panel collapses in place." : "Panel collapses to the corner.", "ok");
});
$("autoSummarize").addEventListener("change", async () => {
  await browser.storage.local.set({ autoSummarize: $("autoSummarize").checked });
  setStatus($("autoSummarize").checked ? "Summarize runs immediately." : "Summarize opens the panel and waits for you.", "ok");
});
$("test").addEventListener("click", testConnection);
$("toggleKey").addEventListener("click", () => {
  const el = $("apiKey");
  const hide = el.type === "text";
  el.type = hide ? "password" : "text";
  $("toggleKey").textContent = hide ? "Show" : "Hide";
});
renderPresets();
load();
