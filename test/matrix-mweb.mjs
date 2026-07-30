#!/usr/bin/env node
import { createHarness, exportGitRef, sleep } from "./lib/harness.mjs";
import * as android from "./lib/android.mjs";
import { Report } from "./lib/report.mjs";

const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i === -1 ? dflt : argv[i + 1];
};
const REF = argOf("--ref", null);
const ONLY = argOf("--cell", null);
const EXPECT_FAIL = argv.includes("--expect-fail");
const CAPTIONED = argOf("--video", "eIho2S0ZahI");
const CAPTIONLESS = argOf("--captionless", "aqz-KE-bpKQ");

const ARTIFACTS = new URL("./artifacts", import.meta.url).pathname;
const PRODUCTION_METHODS = ["intercept", "captions-intercept"];

const CELLS = [
  {
    id: "captions-off-user-play",
    video: CAPTIONED,
    captions: "off",
    play: "user",
    autoplay: "default",
    expect: "intercept",
    regressionFor: "0.5.5 captions-off field failure: player fetches no caption track, nothing to intercept",
    knownBadRef: "8dd1f0d",
  },
  {
    id: "captions-on-user-play",
    video: CAPTIONED,
    captions: "on",
    play: "user",
    autoplay: "default",
    expect: "intercept",
    regressionFor: "the always-passing baseline: this is the only state the old suites ever exercised",
    knownBadRef: null,
  },
  {
    id: "captions-off-cold-tap-strict-autoplay",
    video: CAPTIONED,
    captions: "off",
    play: "none",
    autoplay: "blocked",
    expect: "intercept",
    regressionFor: "0.5.5 gesture-ordering bug: an await before the playback nudge drops user-activation",
    knownBadRef: "dc9d6f4",
  },
  {
    id: "captionless-video",
    video: CAPTIONLESS,
    captions: "off",
    play: "user",
    autoplay: "default",
    expect: "graceful-error",
    regressionFor: "captionless videos must fail with the caption hint, not a bare stack",
    knownBadRef: null,
  },
];

const CONTENT = `
  const player = () => document.querySelector("#movie_player");
  const api = () => { const p = player(); return p && (p.wrappedJSObject || p); };
  const ccBtn = () => document.querySelector(".ytmClosedCaptioningButtonButton");
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const capsOn = () => {
    const a = api();
    const v = safe(() => (a && typeof a.isSubtitlesOn === "function" ? !!a.isSubtitlesOn() : null), null);
    if (v !== null) return v;
    const b = ccBtn();
    return b ? b.getAttribute("aria-pressed") === "true" : null;
  };

  onCmd("state", () => {
    const v = document.querySelector("video");
    const body = document.querySelector("#yapsum-panel .yapsum-panel-body");
    const btn = document.getElementById("yapsum-btn");
    return {
      href: location.href,
      paused: v ? v.paused : null,
      muted: v ? v.muted : null,
      ct: v ? Math.round(v.currentTime * 10) / 10 : null,
      capsOn: capsOn(),
      ccPresent: !!ccBtn(),
      tracklist: safe(() => (api().getOption("captions", "tracklist") || []).length, null),
      btnPresent: !!btn,
      btnText: btn ? (btn.textContent || "").trim() : null,
      method: document.documentElement.dataset.yapsumMethod || null,
      panel: body ? body.textContent.slice(0, 300) : null,
      panelError: body ? body.classList.contains("yapsum-error") : null,
    };
  });

  onCmd("setCaptions", (want) => {
    const a = api();
    for (let i = 0; i < 4; i++) {
      const on = capsOn();
      if (on === want) return { ok: true, on, iters: i };
      if (a && typeof a.toggleSubtitles === "function") safe(() => a.toggleSubtitles());
      else safe(() => ccBtn() && ccBtn().click());
    }
    return { ok: capsOn() === want, on: capsOn() };
  });
`;

const report = new Report("matrix-mweb", { ref: REF || "working-tree", expectFail: EXPECT_FAIL });
const srcDir = REF ? exportGitRef(REF) : null;

async function ensurePlaying(h, video, out) {
  const seen = [];
  for (let i = 0; i < 7; i++) {
    const s = await h.call("state", null, { match: video, timeoutMs: 10000 });
    seen.push(s ? { paused: s.paused, ct: s.ct, href: (s.href || "").slice(-30) } : { noReply: true });
    if (s && s.paused === false && s.ct > 0.4) return s;
    const tap = android.tapPlay(i);
    seen[seen.length - 1].tap = tap.via;
    await sleep(4000);
  }
  if (out) out.playbackAttempts = seen;
  android.screencap(`${ARTIFACTS}/matrix-noplay.png`);
  return null;
}

async function tapSummarize(h, video) {
  for (let i = 0; i < 5; i++) {
    android.dismissDialogs();
    const btn = android.findByText(/^(Summarize|Sum|TL;DW)$/i);
    if (btn) {
      android.tapPoint(btn.cx, btn.cy);
      return { tapped: true, at: { x: btn.cx, y: btn.cy }, label: btn.text };
    }
    const s = await h.call("state", null, { match: video, timeoutMs: 8000 });
    if (s && s.btnPresent) {
      android.tapPoint(540, 1013);
      return { tapped: true, at: { x: 540, y: 1013 }, label: "blind" };
    }
    await sleep(2500);
  }
  return { tapped: false };
}

async function runCell(cell) {
  const h = createHarness({
    target: "android",
    site: "mweb",
    srcDir,
    content: CONTENT,
  });
  const out = { id: cell.id, video: cell.video };
  try {
    if (cell.autoplay === "blocked") android.setPrefs({ "media.autoplay.default": 5, "media.autoplay.blocking_policy": 2 });
    else android.clearPrefs(["media.autoplay.default", "media.autoplay.blocking_policy"]);

    await h.start();
    await h.open(cell.video);
    const ready = await h.waitFor(async () => {
      const s = await h.call("state", null, { match: cell.video, timeoutMs: 8000 });
      return s && s.paused !== null ? s : null;
    }, 90000, "watch page");
    if (!ready) throw new Error(`INFRA: ${cell.id}: watch page never loaded`);

    if (cell.play === "user") {
      const playing = await ensurePlaying(h, cell.video, out);
      if (!playing) throw new Error(`INFRA: ${cell.id}: could not start playback with a real tap`);
      out.startedPlaying = true;
    }

    const wantCaps = cell.captions === "on";
    const setRes = await h.call("setCaptions", wantCaps, { match: cell.video, timeoutMs: 20000 });
    out.captionsSetup = setRes;
    const before = await h.call("state", null, { match: cell.video });
    out.before = { capsOn: before.capsOn, paused: before.paused, ct: before.ct, muted: before.muted };

    const tap = await tapSummarize(h, cell.video);
    out.tap = tap;
    if (!tap.tapped) throw new Error(`INFRA: ${cell.id}: Summarize button never found on screen`);

    const settled = await h.waitFor(async () => {
      const s = await h.call("state", null, { match: cell.video, timeoutMs: 8000 });
      if (!s) return null;
      if (s.method) return s;
      if (s.panel && /Couldn't get a transcript|No API key|Summary failed|Transcript ready/.test(s.panel)) return s;
      return null;
    }, 120000, "summarize outcome");
    out.after = settled
      ? { method: settled.method, panel: (settled.panel || "").slice(0, 160), panelError: settled.panelError }
      : null;

    await sleep(3000);
    const restored = await h.call("state", null, { match: cell.video });
    out.restored = { capsOn: restored.capsOn, paused: restored.paused, ct: restored.ct, muted: restored.muted };
    h.screenshot(`matrix-${cell.id}`);

    if (cell.expect === "intercept") {
      report.check(`matrix:${cell.id}:extracted`, settled && PRODUCTION_METHODS.includes(settled.method), {
        method: settled ? settled.method : null,
        panel: settled ? (settled.panel || "").slice(0, 120) : null,
        why: cell.regressionFor,
      });
    } else {
      const panel = settled ? settled.panel || "" : "";
      report.check(`matrix:${cell.id}:graceful-error`, /Couldn't get a transcript/.test(panel) && /captions/i.test(panel), {
        panel: panel.slice(0, 160),
      });
    }
    report.check(`matrix:${cell.id}:captions-restored`, restored.capsOn === before.capsOn, {
      before: before.capsOn,
      after: restored.capsOn,
      why: "the extension must put the user's caption setting back",
    });
    report.check(`matrix:${cell.id}:muted-restored`, restored.muted === before.muted, {
      before: before.muted,
      after: restored.muted,
    });
  } catch (e) {
    const msg = String(e.message || e);
    if (/^INFRA:/.test(msg)) {
      report.infraFailure = msg.replace(/^INFRA:\s*/, "");
      report.note(`infra:${cell.id}`, msg);
    } else {
      report.check(`matrix:${cell.id}:ran`, false, { error: msg });
    }
    out.error = msg;
  } finally {
    await h.stop();
  }
  report.note(`cell:${cell.id}`, out);
  return out;
}

try {
  report.infra("emulator", () => android.ensureEmulator());
  report.infra("mobile-ua", () => android.setDesktopUa(false));
  for (const cell of CELLS) {
    if (ONLY && cell.id !== ONLY) continue;
    console.log(`\n--- cell ${cell.id} (captions ${cell.captions}, play ${cell.play}, autoplay ${cell.autoplay}) ---`);
    await runCell(cell);
  }
} catch (e) {
  report.fatal(e);
} finally {
  android.clearPrefs(["media.autoplay.default", "media.autoplay.blocking_policy"]);
}

const code = report.finish();
if (EXPECT_FAIL) {
  const anyFailed = report.failed.length > 0;
  console.log(anyFailed ? "\n✅ regression cells FAILED as expected on this ref" : "\n❌ regression cells PASSED on a known-bad ref: the test has no teeth");
  process.exit(anyFailed ? 0 : 1);
}
process.exit(code);
