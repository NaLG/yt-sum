#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const FAST = process.argv.includes("--fast");
const ROOT = new URL("..", import.meta.url).pathname;

const SUITES = [
  { name: "lint", cmd: "web-ext", args: ["lint", "--source-dir", "src"], timeout: 120 },
  { name: "style (comment budget, no em-dashes)", cmd: "node", args: ["test/lint-style.mjs"], timeout: 30 },
  { name: "leak bounds (background collections)", cmd: "node", args: ["test/leak-bounds.mjs"], timeout: 30 },
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
    console.log(r.out.split("\n").slice(-25).join("\n"));
  }
}

const leakedBrowsers = execFileSync("ps", ["-axo", "pid=,command="]).toString().split("\n")
  .filter((line) => /firefox/i.test(line) && line.includes(`-profile ${tmpdir()}`));
if (leakedBrowsers.length) {
  console.log(`✗ ${leakedBrowsers.length} leaked test browser(s), now killed:`);
  for (const line of leakedBrowsers) console.log("  " + line.trim().slice(0, 140));
  try { execFileSync("/bin/sh", ["-c", `pkill -f 'firefox.*-profile ${tmpdir()}'; true`]); } catch {}
  results.push({ name: "no leaked browser processes", code: 1, secs: 0 });
} else {
  results.push({ name: "no leaked browser processes", code: 0, secs: 0 });
}

console.log("\n== summary ==");
for (const r of results) console.log(`${r.code === 0 ? "✓" : "✗"} ${r.name.padEnd(38)} ${r.secs}s`);
const failed = results.filter((r) => r.code !== 0);
console.log(failed.length ? `\n❌ ${failed.length}/${results.length} check(s) failed` : `\n✅ all ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
