import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractFor } from "../contract.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
export const EXIT_OK = 0;
export const EXIT_CONTRACT = 1;
export const EXIT_INFRA = 2;

export class Report {
  constructor(name, meta = {}) {
    this.name = name;
    this.meta = meta;
    this.checks = [];
    this.notes = [];
    this.infraFailure = null;
    this.startedAt = new Date().toISOString();
  }

  check(contractId, ok, detail = {}) {
    const item = contractFor(contractId, { optional: true });
    this.checks.push({
      id: contractId,
      ok: !!ok,
      severity: item ? item.severity : "unknown",
      surface: item ? item.surface : this.meta.surface || null,
      why: item ? item.why : null,
      dependedOnBy: item ? item.dependedOnBy : [],
      detail,
    });
    const mark = ok ? "✓" : "✗";
    console.log(`${mark} ${contractId}${ok ? "" : "  " + JSON.stringify(detail).slice(0, 220)}`);
    return !!ok;
  }

  note(key, value) {
    this.notes.push({ key, value });
    if (process.env.YAPSUM_DEBUG === "1") console.log(`  note ${key}: ${JSON.stringify(value).slice(0, 200)}`);
  }

  infra(label, fn) {
    try {
      const value = fn();
      this.note(`infra:${label}`, value === undefined ? "ok" : value);
      return value;
    } catch (e) {
      this.infraFailure = `${label}: ${e.message}`;
      throw new Error(`INFRA: ${label}: ${e.message}`);
    }
  }

  fatal(e) {
    const msg = String((e && e.message) || e);
    if (/^INFRA:/.test(msg) || this.infraFailure) {
      this.infraFailure = this.infraFailure || msg.replace(/^INFRA:\s*/, "");
      console.log(`\n⚠ inconclusive (environment): ${this.infraFailure}`);
    } else {
      this.checks.push({ id: "run-completed", ok: false, severity: "critical", detail: { error: msg } });
      console.log(`\n✗ run threw: ${msg}`);
    }
  }

  get failed() {
    return this.checks.filter((c) => !c.ok);
  }

  finish({ write = true } = {}) {
    const failed = this.failed;
    const summary = {
      suite: this.name,
      meta: this.meta,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      infraFailure: this.infraFailure,
      total: this.checks.length,
      failed: failed.length,
      checks: this.checks,
      notes: this.notes,
    };
    if (write) {
      const dir = join(ROOT, "test", "artifacts", "reports");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${this.name}.json`), JSON.stringify(summary, null, 2));
    }
    console.log("");
    if (this.infraFailure && !this.checks.length) {
      console.log(`⚠ ${this.name}: INCONCLUSIVE (${this.infraFailure})`);
      return EXIT_INFRA;
    }
    if (!failed.length) {
      console.log(`✅ ${this.name}: ${this.checks.length}/${this.checks.length} contract checks hold`);
      return this.infraFailure ? EXIT_INFRA : EXIT_OK;
    }
    console.log(`❌ ${this.name}: ${failed.length}/${this.checks.length} contract check(s) FAILED`);
    for (const c of failed) {
      console.log(`   ${c.id} [${c.severity}]`);
      if (c.why) console.log(`     assumption: ${c.why}`);
      if (c.dependedOnBy && c.dependedOnBy.length) console.log(`     code that depends on it: ${c.dependedOnBy.join(", ")}`);
    }
    return EXIT_CONTRACT;
  }
}
