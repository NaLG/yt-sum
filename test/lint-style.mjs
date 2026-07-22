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

const jsFiles = [...globSync("src/**/*.js"), ...globSync("test/*.mjs"), ...globSync("scripts/*.mjs")];
for (const path of jsFiles) {
  let src = readFileSync(path, "utf8");
  if (src.includes("\u2014")) fail(`${path}: contains an em-dash`);
  if (src.startsWith("#!")) src = src.slice(src.indexOf("\n") + 1);
  const sourceType = path.endsWith(".mjs") ? "module" : "script";
  let comments;
  try {
    comments = espree.parse(src, { ecmaVersion: "latest", sourceType, comment: true, loc: true }).comments;
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
