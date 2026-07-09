// yap-sum settings page.

const FIELDS = ["provider", "baseUrl", "model", "apiKey", "systemPrompt", "maxTokens", "maxTranscriptChars"];
const $ = (id) => document.getElementById(id);

let DEFAULTS = null;

const BASE_URL_HINTS = {
  openai: 'e.g. https://api.openai.com/v1 · GLM: https://api.z.ai/api/paas/v4 · Ollama: http://localhost:11434/v1',
  anthropic: "https://api.anthropic.com/v1 (native Claude Messages API)",
};

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

function fillModelList(ids) {
  const dl = $("modelList");
  dl.innerHTML = "";
  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    dl.appendChild(opt);
  }
}

// Fetch the provider's live model catalog from {baseUrl}/models. Works for any
// OpenAI-compatible endpoint (OpenRouter, GLM, Gemini, Groq, Ollama, LM Studio)
// and for the native Anthropic API — both return { data: [{ id }] }.
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
    if (!silent) setStatus(`Loaded ${ids.length} models — click the Model field to choose.`, "ok");
  } catch (e) {
    // Fall back to curated suggestions so the dropdown still works.
    fillModelList(FALLBACK_MODELS[provider] || []);
    if (!silent) setStatus(`Couldn't load live model list (${e.message}). Showing suggestions; you can also type any id.`, "err");
  }
}

async function load() {
  DEFAULTS = await browser.runtime.sendMessage({ type: "getDefaults" });
  const stored = await browser.storage.local.get(FIELDS);
  const cfg = { ...DEFAULTS, ...stored };
  for (const f of FIELDS) if ($(f)) $(f).value = cfg[f];
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
  if (!granted) throw new Error(`Permission to reach ${origin} was declined. yap-sum can't call that endpoint without it.`);
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
    if (res.ok) setStatus("Connection OK — endpoint and key work.", "ok");
    else setStatus(`Endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`, "err");
  } catch (e) {
    setStatus(`Failed: ${e.message}`, "err");
  }
}

$("provider").addEventListener("change", () => {
  updateHint();
  fillModelList(FALLBACK_MODELS[$("provider").value] || []);
});
$("loadModels").addEventListener("click", () => loadModels(false));
$("save").addEventListener("click", save);
$("reset").addEventListener("click", reset);
$("test").addEventListener("click", testConnection);
load();
