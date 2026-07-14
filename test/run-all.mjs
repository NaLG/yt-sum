#!/usr/bin/env node
// Release gate: run the whole deterministic suite sequentially (each test
// spawns its own Firefox; parallel runs fight over the profile and the
// window manager) and print one summary table. Exit 0 only if every suite
// passed. Rendering artifacts (viewport screenshots) land in test/artifacts/
// for human eyeballing; they are advisory and never gate the run.
//
//   node test/run-all.mjs           # full gate (lint + all suites)
//   node test/run-all.mjs --fast    # skip the slow end-to-end + live-extraction suites
//
// Individual suites remain runnable directly (see package.json scripts).

import { spawn } from "node:child_process";

const FAST = process.argv.includes("--fast");
const ROOT = new URL("..", import.meta.url).pathname;

const SUITES = [
  { name: "lint", cmd: "web-ext", args: ["lint", "--source-dir", "src"], timeout: 120 },
  { name: "options (geckodriver)", cmd: "node", args: ["test/smoke-options.mjs"], timeout: 180 },
  { name: "placement + styles", cmd: "node", args: ["test/smoke-placement.mjs"], timeout: 180 },
  { name: "shorts exclusion", cmd: "node", args: ["test/smoke-shorts.mjs"], timeout: 180 },
  ...(FAST ? [] : [
    { name: "end-to-end (mock LLM)", cmd: "node", args: ["test/smoke-full.mjs"], timeout: 300 },
    { name: "extraction (live YouTube)", cmd: "node", args: ["test/webext-validate.mjs"], timeout: 300 },
  ]),
];

const run = (s) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(s.cmd, s.args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const grab = (d) => { out += d; if (process.env.YAPSUM_DEBUG === "1") process.stdout.write(d); };
    child.stdout.on("data", grab);
    child.stderr.on("data", grab);
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, s.timeout * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ...s, code, secs: Math.round((Date.now() - started) / 1000), out });
    });
  });

const results = [];
for (const s of SUITES) {
  process.stdout.write(`▸ ${s.name} … `);
  const r = await run(s);
  results.push(r);
  console.log(r.code === 0 ? `✓ (${r.secs}s)` : `✗ (${r.secs}s, exit ${r.code})`);
  if (r.code !== 0) {
    // Show the failing suite's tail immediately, that's what you act on.
    console.log(r.out.split("\n").slice(-25).join("\n"));
  }
}

console.log("\n== summary ==");
for (const r of results) console.log(`${r.code === 0 ? "✓" : "✗"} ${r.name.padEnd(28)} ${r.secs}s`);
const failed = results.filter((r) => r.code !== 0);
console.log(failed.length ? `\n❌ ${failed.length}/${results.length} suite(s) failed` : `\n✅ all ${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
