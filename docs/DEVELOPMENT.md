# Development

Working notes for building, testing, and releasing Return YouTube Summary.
The user-facing intro lives in the [README](../README.md); the
transcript-extraction deep dive is [EXTRACTION.md](EXTRACTION.md).

## Develop & test

```sh
npm install
npm run lint                         # web-ext lint (0 errors)
npm run run:desktop                  # launch in desktop Firefox on a test video
node test/smoke-full.mjs [VIDEO_ID]  # AUTHORITATIVE full path: click → extract →
                                     #   (mock LLM) → rendered summary → follow-up
YAPSUM_CHUNK=1 node test/smoke-full.mjs   # exercise the long-video chunking path
node test/smoke-options.mjs          # settings page
node test/smoke-ui.mjs               # button injection
node test/webext-validate.mjs        # extraction-only, in real Firefox
node test/smoke-placement.mjs        # button placement + all styles, geometric asserts
node test/smoke-placement.mjs --target firefox-android   # same on the emulator (mobile site)
npm run build                        # -> dist/<name>-<version>.zip
```

Tests run the **real** source inside a normal Firefox via `web-ext` (never
WebDriver, YouTube detects and blocks marionette) and relay results to a
localhost server.

### Android (device or device-free emulator)

```sh
npm run emulator                     # boot a headless emulator, provisioned for tests
npm run test:android                 # extraction test on the emulator/device
npm run run:android                  # launch on a USB-connected phone
```

See [MOBILE-TESTING.md](../MOBILE-TESTING.md) for installing on a real phone
and the signing path.

#### Verifying mobile UI (screenshots on the emulator)

The extraction harness runs the DESKTOP site inside Fenix; button placement on
the real mobile site must be verified by eye. Recipe (all adb via
`. scripts/android-env.sh`, the Homebrew adb hangs at exec):

1. `npm run emulator`, then strip the provisioned desktop-UA override so
   YouTube serves true m.youtube.com: delete the `general.useragent.override`
   line from `user.js` in the Fenix Gecko profile (adb root + sed), force-stop
   Firefox. The next `npm run emulator` re-adds it automatically.
2. `. scripts/android-env.sh && node scripts/run-android.mjs` (installs the
   temp add-on; `--start-url` is NOT supported on Android).
3. Open the page by intent: `adb shell am start -a android.intent.action.VIEW
   -d "https://m.youtube.com/watch?v=..." org.mozilla.firefox`.
4. `adb exec-out screencap -p > shot.png` and look at it. Expect emulator ANR
   dialogs; dismiss with `adb shell input tap`.

## Publishing

[SUBMISSION.md](../SUBMISSION.md) is the AMO submission kit, listing copy, data
disclosure, reviewer notes, and the build/sign steps. Remember: AMO version
numbers are unique per add-on id across channels, so every sideload-signed
build burns a number and the listed upload takes the next one.

## Layout

```
src/
  manifest.json             MV2 (Mozilla's recommendation for Firefox Android)
  content/
    extractor.js            transcript parsing (page-context; also test-imported)
    content.js              button injection, summarize + follow-up flow, panel UI
    content.css             injected styles (light/dark, mobile bottom-sheet)
  background/background.js   network intercept + LLM providers + SSE streaming
  options/                  settings page + toolbar popup
  icons/                    48/96/128/512 (green "TL;DW" mark)
test/
  smoke-full.mjs            authoritative end-to-end test (extract → summary → Q&A)
  webext-validate.mjs       extraction test (desktop + android)
  probe*.mjs                probes used to characterize YouTube's transcript variants
docs/                       EXTRACTION.md, DEVELOPMENT.md, screenshots
scripts/                    android emulator + device launchers
```
