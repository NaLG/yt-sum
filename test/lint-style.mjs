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

function checkCaptionKickVerified(path, program) {
  const fns = {};
  const collect = (n) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "FunctionDeclaration" && n.id?.name) fns[n.id.name] = n;
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "range") continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v.type === "string") collect(v);
    }
  };
  collect(program);

  const togglers = Object.keys(fns).filter((name) => {
    let calls = false;
    const walk = (n) => {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "CallExpression") {
        const callee = n.callee;
        if (callee?.property?.name === "toggleSubtitles") calls = true;
        if (callee?.name === "toggleMobileCaptions") calls = true;
      }
      for (const key of Object.keys(n)) {
        if (key === "loc" || key === "range") continue;
        const v = n[key];
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v.type === "string") walk(v);
      }
    };
    walk(fns[name].body);
    return calls;
  });
  if (!togglers.length) return;

  const verifiers = togglers.filter((name) => {
    let readsState = false;
    const walk = (n) => {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "CallExpression") {
        const callee = n.callee;
        if (callee?.name === "mobileCaptionsOn" || callee?.property?.name === "isSubtitlesOn") readsState = true;
      }
      for (const key of Object.keys(n)) {
        if (key === "loc" || key === "range") continue;
        const v = n[key];
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v.type === "string") walk(v);
      }
    };
    walk(fns[name].body);
    return readsState;
  });

  if (!verifiers.length) {
    fail(
      `${path}: a function toggles captions (${togglers.join(", ")}) but none re-reads caption state afterwards. ` +
        "toggleSubtitles() silently no-ops before YouTube's captions module loads, so a fire-and-forget toggle " +
        "is indistinguishable from success (this shipped as the 0.5.6 caption kick)"
    );
    return;
  }

  const gated = verifiers.some((name) => {
    let ready = false;
    const walk = (n) => {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "CallExpression" && n.callee?.name === "mobileCaptionsReady") ready = true;
      for (const key of Object.keys(n)) {
        if (key === "loc" || key === "range") continue;
        const v = n[key];
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v.type === "string") walk(v);
      }
    };
    walk(fns[name].body);
    return ready;
  });
  if (!gated) {
    fail(
      `${path}: the caption toggle is verified but never gated on mobileCaptionsReady(); ` +
        "toggling before the captions module loads burns the attempt silently"
    );
  }
}

const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg === -1 ? "." : process.argv[rootArg + 1].replace(/\/$/, "");
const scoped = (p) => globSync(`${ROOT}/${p}`);
const jsFiles = rootArg === -1
  ? [...scoped("src/**/*.js"), ...scoped("test/*.mjs"), ...scoped("scripts/*.mjs")]
  : scoped("src/**/*.js");
for (const path of jsFiles) {
  let src = readFileSync(path, "utf8");
  if (src.includes("\u2014")) fail(`${path}: contains an em-dash`);
  if (src.startsWith("#!")) src = src.slice(src.indexOf("\n") + 1);
  const sourceType = path.endsWith(".mjs") ? "module" : "script";
  let comments;
  try {
    const program = espree.parse(src, { ecmaVersion: "latest", sourceType, comment: true, loc: true, range: true });
    comments = program.comments;
    if (path.endsWith("src/content/content.js") || path === "src/content/content.js") { checkGestureOrder(path, program); checkCaptionKickVerified(path, program); }
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

for (const path of scoped("src/**/*.css")) {
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
