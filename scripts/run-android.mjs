#!/usr/bin/env node
// Launch yap-sum on a USB-connected Android device running Firefox, via web-ext.
// Prereqs (one-time on the phone):
//   1. Enable Developer options -> USB debugging.
//   2. In Firefox for Android: Settings -> Remote debugging via USB -> ON.
//   3. Plug in over USB, accept the "Allow USB debugging?" prompt.
// Then: `node scripts/run-android.mjs` (or `npm run run:android`).

import { execFileSync, spawn } from "node:child_process";

const APK = process.env.YAPSUM_FIREFOX_APK || "org.mozilla.firefox"; // release; beta=org.mozilla.firefox_beta, nightly=org.mozilla.fenix
const START_URL = process.argv[2] || "https://www.youtube.com/watch?v=eIho2S0ZahI";

function adbDevices() {
  try {
    const out = execFileSync("adb", ["devices"], { encoding: "utf8" });
    return out
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("*"))
      .map((l) => l.split(/\s+/))
      .filter(([, state]) => state === "device")
      .map(([id]) => id);
  } catch (e) {
    console.error("adb not found or failed. Install with: brew install --cask android-platform-tools");
    process.exit(1);
  }
}

const devices = adbDevices();
if (devices.length === 0) {
  console.error(
    "No authorized Android device found.\n" +
      "  • Plug the phone in over USB.\n" +
      "  • Enable USB debugging (Developer options) and accept the on-device prompt.\n" +
      "  • Enable Firefox → Settings → Remote debugging via USB.\n" +
      "  • Verify with: adb devices"
  );
  process.exit(1);
}
const device = devices[0];
console.log(`Using device ${device}, Firefox APK ${APK}`);
console.log(`Starting yap-sum → ${START_URL}\n`);

const child = spawn(
  "web-ext",
  [
    "run",
    "--source-dir", "src",
    "--target", "firefox-android",
    "--android-device", device,
    "--firefox-apk", APK,
    "--start-url", START_URL,
  ],
  { stdio: "inherit" }
);
child.on("exit", (code) => process.exit(code ?? 0));
