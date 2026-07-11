// yap-sum settings page.

const FIELDS = ["provider", "baseUrl", "model", "apiKey", "systemPrompt", "maxTokens", "maxTranscriptChars"];
const $ = (id) => document.getElementById(id);

let DEFAULTS = null;

const BASE_URL_HINTS = {
  openai: 'e.g. https://api.openai.com/v1 · GLM: https://api.z.ai/api/paas/v4 · Ollama: http://localhost:11434/v1',
  anthropic: "https://api.anthropic.com/v1 (native Claude Messages API)",
};

// Clickable quick-setup presets. Clicking one fills provider + base URL + a
// sensible default model.
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
  updateHint();
  fillModelList(FALLBACK_MODELS[p.provider] || []);
  syncModelSelect();
  setStatus(`Filled ${p.label}. Add your API key, then Save (or Load models to pick one).`, "ok");
}

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + kind;
}

function updateHint() {
  $("baseUrlHint").textContent = BASE_URL_HINTS[$("provider").value] || "";
}

// Curated fallback suggestions so the dropdown is never empty, even before a
// live load. Replaced by the real /models list when "Load models" is clicked.
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

// Populate the model <select> dropdown. The text input (#model) stays the
// source of truth; picking from the dropdown writes into it, and it always has
// a "Custom" escape hatch for ids not in the list.
let currentModelIds = [];
function fillModelList(ids) {
  currentModelIds = ids.slice();
  const sel = $("modelSelect");
  sel.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = ids.length ? "Pick a model…" : "(click Load models)";
  sel.appendChild(placeholder);
  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    sel.appendChild(opt);
  }
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "✏️ Custom / type your own…";
  sel.appendChild(custom);
  syncModelSelect();
}

// Reflect the text-input value in the dropdown selection.
function syncModelSelect() {
  const sel = $("modelSelect");
  const val = $("model").value;
  if (val && currentModelIds.includes(val)) sel.value = val;
  else if (val) sel.value = "__custom__";
  else sel.value = "";
}

// Fetch the provider's live model catalog from {baseUrl}/models. Works for any
// OpenAI-compatible endpoint (OpenRouter, GLM, Gemini, Groq, Ollama, LM Studio)
// and for the native Anthropic API, both return { data: [{ id }] }.
async function loadModels(silent = false) {
  const provider = $("provider").value;
  const baseUrl = $("baseUrl").value.replace(/\/$/, "");
  const apiKey = $("apiKey").value;
  if (!baseUrl) {
    if (!silent) setStatus("Enter a base URL first.", "err");
    return;
  }
  if (!silent) setStatus("Loading models…", "");
  try {
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
    fillModelList(ids);
    if (!silent) setStatus(`Loaded ${ids.length} models, click the Model field to choose.`, "ok");
  } catch (e) {
    // Fall back to curated suggestions so the dropdown still works.
    fillModelList(FALLBACK_MODELS[provider] || []);
    if (!silent) setStatus(`Couldn't load live model list (${e.message}). Showing suggestions; you can also type any id.`, "err");
  }
}

async function load() {
  // {} fallback: on a cold install the background page can still be starting;
  // stored values and the curated model list must not depend on it.
  DEFAULTS = await browser.runtime.sendMessage({ type: "getDefaults" }).catch(() => ({}));
  const stored = await browser.storage.local.get(FIELDS);
  const cfg = { ...DEFAULTS, ...stored };
  for (const f of FIELDS) if ($(f)) $(f).value = cfg[f];
  const { buttonStyle } = await browser.storage.local.get({ buttonStyle: "text" });
  const styleVal = ["icon", "tldw", "sum"].includes(buttonStyle) ? buttonStyle : "text";
  const radio = document.querySelector(`input[name="buttonStyle"][value="${styleVal}"]`);
  if (radio) radio.checked = true;
  updateHint();
  // Seed the dropdown with curated suggestions immediately; a live load
  // refreshes them when the user clicks "Load models" (or Test connection).
  fillModelList(FALLBACK_MODELS[cfg.provider] || []);
}

// Ensure we have host permission to reach a non-default endpoint (local servers,
// custom hosts). YouTube + the listed providers we could pre-declare, but BYO
// URLs are open-ended, so request at save time.
async function ensureHostPermission(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin + "/*";
  } catch {
    throw new Error("Base URL is not a valid URL.");
  }
  const has = await browser.permissions.contains({ origins: [origin] });
  if (has) return true;
  // permissions.request needs a user gesture (the Save/Test click) and isn't
  // available on older Firefox for Android. Well-known provider hosts are
  // already granted via the manifest, so this path is only hit for custom/local
  // endpoints.
  if (!browser.permissions.request) {
    throw new Error(
      `This Firefox can't grant access to ${origin} at runtime. ` +
        `Custom/local endpoints need a newer Firefox for Android, or use one of the built-in provider hosts.`
    );
  }
  const granted = await browser.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`Permission to reach ${origin} was declined. Return YouTube Summary can't call that endpoint without it.`);
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
  try {
    await ensureHostPermission(cfg.baseUrl);
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

// Fire a tiny non-streaming request to verify the endpoint + key.
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
  updateHint();
  fillModelList(FALLBACK_MODELS[$("provider").value] || []);
});
// Dropdown → text input. "Custom" focuses the field for manual entry.
$("modelSelect").addEventListener("change", () => {
  const v = $("modelSelect").value;
  if (v === "__custom__") {
    $("model").focus();
  } else if (v) {
    $("model").value = v;
  }
});
// Typing in the field re-syncs the dropdown (shows "Custom" for unlisted ids).
$("model").addEventListener("input", syncModelSelect);
$("loadModels").addEventListener("click", () => loadModels(false));
$("save").addEventListener("click", save);
$("reset").addEventListener("click", reset);
// Button style is cosmetic and applies instantly (content script listens on
// storage.onChanged), so it saves on click rather than waiting for Save.
for (const r of document.querySelectorAll('input[name="buttonStyle"]')) {
  r.addEventListener("change", async () => {
    await browser.storage.local.set({ buttonStyle: ["icon", "tldw", "sum"].includes(r.value) ? r.value : "text" });
    setStatus("Button style saved.", "ok");
  });
}
$("test").addEventListener("click", testConnection);
// Key is visible by default so pasting/editing (e.g. trimming stray text off a
// pasted string) is easy; the toggle masks it for shoulder-surfing / sharing.
$("toggleKey").addEventListener("click", () => {
  const el = $("apiKey");
  const hide = el.type === "text";
  el.type = hide ? "password" : "text";
  $("toggleKey").textContent = hide ? "Show" : "Hide";
});
renderPresets();
load();
