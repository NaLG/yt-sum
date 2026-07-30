#!/usr/bin/env node
import { readFileSync, globSync } from "node:fs";
import { createRequire } from "node:module";
import { CONTRACT } from "./contract.mjs";

const espree = createRequire(import.meta.url)("espree");

const YT_TAG = /\b(ytd|ytm|yt|tp-yt)-[a-z0-9-]+\b/;
const YT_CLASS = /\b(ytp|ytm|ytw)[A-Za-z-]{3,}\b/;
const SELECTORY = /[#.\[]|>\s|::/;
const PLAYER_ID = /movie_player|html5-video-player|#player\b/;

const EXEMPT = new Set([
  "#yapsum-panel",
  "#yapsum-btn",
  "#yapsum-panel .yapsum-panel-body",
  "#settings",
]);

const registered = new Map();
for (const item of CONTRACT) {
  if (item.expr.startsWith("(")) continue;
  registered.set(item.expr, item);
  for (const part of item.expr.split(",")) {
    const t = part.trim();
    if (t) registered.set(t, item);
  }
}

let failures = 0;
const fail = (m) => { console.log("✗ " + m); failures++; };

function looksLikeYouTubeSurface(value) {
  if (typeof value !== "string" || value.length < 3 || value.length > 400) return false;
  if (value.startsWith("yapsum") || value.includes("yapsum-")) return false;
  if (PLAYER_ID.test(value)) return true;
  if (YT_TAG.test(value)) return true;
  if (YT_CLASS.test(value)) return true;
  return false;
}

function isRegistered(value) {
  if (EXEMPT.has(value) || registered.has(value)) return true;
  for (const part of value.split(",")) {
    const t = part.trim();
    if (t && registered.has(t)) return true;
  }
  for (const expr of registered.keys()) {
    if (expr.length > 6 && (value.includes(expr) || expr.includes(value))) return true;
  }
  return false;
}

const files = globSync("src/**/*.js");
const unregistered = [];
for (const path of files) {
  let src = readFileSync(path, "utf8");
  if (src.startsWith("#!")) src = src.slice(src.indexOf("\n") + 1);
  let program;
  try {
    program = espree.parse(src, { ecmaVersion: "latest", sourceType: "script", loc: true, range: true });
  } catch (e) {
    fail(`${path}: parse error (${e.message})`);
    continue;
  }
  const walk = (n) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "Literal" && typeof n.value === "string" && looksLikeYouTubeSurface(n.value) && !isRegistered(n.value)) {
      unregistered.push({ path, line: n.loc.start.line, value: n.value.slice(0, 90) });
    }
    if (n.type === "TemplateLiteral") {
      for (const q of n.quasis) {
        const v = q.value.cooked || "";
        if (looksLikeYouTubeSurface(v) && !isRegistered(v)) unregistered.push({ path, line: q.loc.start.line, value: v.slice(0, 90) });
      }
    }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "range" || key === "parent") continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  };
  walk(program);
}

for (const u of unregistered) {
  fail(`${u.path}:${u.line}: YouTube surface "${u.value}" is not registered in test/contract.mjs`);
}

const checkedIds = new Set();
for (const suite of [...globSync("test/canary-*.mjs"), ...globSync("test/matrix-*.mjs")]) {
  const body = readFileSync(suite, "utf8");
  for (const m of body.matchAll(/report\.check\(\s*(?:`|")([a-z0-9:${}.\-]+)(?:`|")/gi)) checkedIds.add(m[1]);
}
const known = new Set(CONTRACT.map((i) => i.id));
for (const id of checkedIds) {
  if (!id.includes("$") && !id.startsWith("matrix:") && !known.has(id)) {
    fail(`a canary checks contract id "${id}" which is not registered in test/contract.mjs`);
  }
}
const covered = CONTRACT.filter((i) => checkedIds.has(i.id));
const missingCoverage = CONTRACT.filter((i) => i.severity === "critical" && !checkedIds.has(i.id));

console.log("");
if (failures) {
  console.log(`❌ ${failures} unregistered YouTube surface(s).`);
  console.log("Every selector, tag, or player id the extension depends on must be declared in");
  console.log("test/contract.mjs with a severity and a note on what breaks, so the canary can");
  console.log("watch it and a failure names the code to fix.");
  process.exit(1);
}
console.log(`✅ contract clean: ${CONTRACT.length} registered surfaces, ${covered.length} runtime-checked, ${files.length} source files scanned`);
if (missingCoverage.length) {
  console.log(`   note: ${missingCoverage.length} critical item(s) have no runtime check yet: ${missingCoverage.slice(0, 6).map((i) => i.id).join(", ")}`);
}
process.exit(0);
