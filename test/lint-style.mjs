#!/usr/bin/env node
import { readFileSync, globSync } from "node:fs";
import { createRequire } from "node:module";

const espree = createRequire(import.meta.url)("espree");
const COMMENT_LINE_BUDGET = 2;
const CSS_COMMENT_BUDGET = 0;

let failures = 0;
const fail = (msg) => {
  console.log("✗ " + msg);
  failures++;
};

const GESTURE_ENTRIES = ["onSummarizeClick", "runSummarize", "ask"];
function checkGestureOrder(path, program) {
  const bodies = {};
  const findTargets = (n) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "FunctionDeclaration" && GESTURE_ENTRIES.includes(n.id?.name)) bodies[n.id.name] = n.body;
    if (n.type === "VariableDeclarator" && GESTURE_ENTRIES.includes(n.id?.name) && /Function/.test(n.init?.type || "")) bodies[n.id.name] = n.init.body;
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (Array.isArray(v)) v.forEach(findTargets);
      else if (v && typeof v.type === "string") findTargets(v);
    }
  };
  findTargets(program);
  for (const name of GESTURE_ENTRIES) {
    if (!bodies[name]) {
      fail(`${path}: gesture entry ${name}() not found; update GESTURE_ENTRIES in lint-style`);
      continue;
    }
    let kickAt = Infinity;
    let awaitAt = Infinity;
    const walk = (n) => {
      if (!n || typeof n.type !== "string") return;
      if (/Function/.test(n.type)) return;
      if (n.type === "CallExpression" && n.callee?.name === "kickMobilePlayback") kickAt = Math.min(kickAt, n.range[0]);
      if (n.type === "AwaitExpression") awaitAt = Math.min(awaitAt, n.range[0]);
      for (const key of Object.keys(n)) {
        if (key === "loc" || key === "range") continue;
        const v = n[key];
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v.type === "string") walk(v);
      }
    };
    for (const stmt of bodies[name].body) walk(stmt);
    if (kickAt === Infinity) fail(`${path}: ${name}() never calls kickMobilePlayback(); mobile transcripts need the playback nudge`);
    else if (awaitAt < kickAt) fail(`${path}: ${name}() awaits before kickMobilePlayback(); the await ends the user-activation and autoplay-blocked phones reject play()`);
  }
}

const jsFiles = [...globSync("src/**/*.js"), ...globSync("test/*.mjs"), ...globSync("scripts/*.mjs")];
for (const path of jsFiles) {
  let src = readFileSync(path, "utf8");
  if (src.includes("\u2014")) fail(`${path}: contains an em-dash`);
  if (src.startsWith("#!")) src = src.slice(src.indexOf("\n") + 1);
  const sourceType = path.endsWith(".mjs") ? "module" : "script";
  let comments;
  try {
    const program = espree.parse(src, { ecmaVersion: "latest", sourceType, comment: true, loc: true, range: true });
    comments = program.comments;
    if (path.endsWith("src/content/content.js") || path === "src/content/content.js") checkGestureOrder(path, program);
  } catch (e) {
    fail(`${path}: parse error (${e.message})`);
    continue;
  }
  const commentLines = new Set();
  for (const c of comments)
    for (let l = c.loc.start.line; l <= c.loc.end.line; l++) commentLines.add(l);
  if (commentLines.size > COMMENT_LINE_BUDGET)
    fail(`${path}: ${commentLines.size} comment lines exceed the budget of ${COMMENT_LINE_BUDGET}; make the code self-defining; rationale goes in docs/ARCHITECTURE.md`);
}

for (const path of globSync("src/**/*.css")) {
  const src = readFileSync(path, "utf8");
  if (src.includes("\u2014")) fail(`${path}: contains an em-dash`);
  const count = (src.match(/\/\*/g) || []).length;
  if (count > CSS_COMMENT_BUDGET) fail(`${path}: ${count} CSS comments exceed the budget of ${CSS_COMMENT_BUDGET}`);
}

console.log(
  failures
    ? `\n❌ ${failures} style violation(s)`
    : `\n✅ style clean: ${jsFiles.length} js files within ${COMMENT_LINE_BUDGET} comment lines, no em-dashes`
);
process.exit(failures ? 1 : 0);
