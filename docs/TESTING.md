# Testing and the YouTube contract

Why this exists: three Android bugs shipped in three consecutive releases, each
with a green 9-check gate. None of them were logic errors the gate could see.
All three were **assumptions about YouTube** that stopped holding, or that never
held in the environment the user actually runs:

1. 0.5.4: captures were evicted after 10 minutes, so any longer watch failed.
2. 0.5.4/0.5.5: an `await` before the playback nudge dropped the tap's
   user-activation, so autoplay-blocked phones silently refused to play.
3. 0.5.5: the mweb player fetches captions ONLY while caption display is on, so
   a user watching with captions off produced nothing to intercept.

The old gate could not catch any of them, because it ran one path, in one
environment, on the desktop site, with the fallbacks free to paper over a dead
primary path. The layers below exist to fix exactly that.

## The three layers

| Layer | What it answers | Needs a browser | In the release gate |
| --- | --- | --- | --- |
| `test/contract.mjs` + `test/lint-contract.mjs` | Is every YouTube dependency written down? | no | yes |
| `test/canary-*.mjs` | Do YouTube's surfaces and behaviors still hold? | yes, live YouTube | no, weekly |
| `test/matrix-mweb.mjs` | Does the real extraction path work across the states that broke us? | yes, emulator | no, weekly |

### 1. The contract

`test/contract.mjs` is the registry of every YouTube surface the extension
depends on: 153 entries covering selectors, player APIs, network endpoints,
response shapes, behaviors and load-bearing timing constants. Each entry says
what it is, which source depends on it, what breaks when it stops holding, and
how bad that is.

`test/lint-contract.mjs` (in the gate) parses `src/` for anything that looks
like a YouTube surface (a `ytd-`/`ytm-`/`yt-` tag, a `ytp`/`ytm`/`ytw` class, a
player id) and fails if it is not registered. **Adding a new YouTube dependency
now fails the build until you write down what it is and what breaks.** It also
cross-checks that every contract id a canary asserts actually exists, and
reports which critical items still have no runtime check.

### 2. The canaries

Canaries test **YouTube, not us**. `canary-mweb.mjs` runs a bare probe
extension containing none of the extension's source, so it keeps working as a
measurement even when our own code is broken. That matters: a canary that
depends on the code under test cannot tell you which of the two failed.

They assert behavior, not just selectors. The two most valuable checks encode
the exact thing that cost a release:

- `mweb-caption-fetch-requires-display`: with captions off on a cold page load,
  15s of playback must produce **zero** `/api/timedtext` requests.
- `mweb-caption-fetch-on-display`: enabling captions must produce one, PoToken
  signed, `fmt=json3`, whose body parses to more than zero segments.

Both directions are informative. If the first starts failing, YouTube began
fetching captions unconditionally and the 0.5.6 caption kick can be deleted. If
the second fails, mobile extraction has no path at all and needs a new trigger.

Measure the quiet window on a **cold** page load. Toggling captions loads the
player's captions module, which then fetches on its own; measuring after any
caption interaction reports a fetch that a real captions-off user never makes.

### 3. The state matrix

`test/matrix-mweb.mjs` runs the **real production path** (background
`webRequest` capture, content-script poll) on true `m.youtube.com`, across the
state axes that actually broke:

| Cell | Captions | Playback | Autoplay | Regression for |
| --- | --- | --- | --- | --- |
| `captions-off-user-play` | off | real tap | default | the 0.5.5 field failure |
| `captions-on-user-play` | on | real tap | default | the only state old suites ever ran |
| `captions-off-cold-tap-strict-autoplay` | off | none | blocked | the gesture-ordering bug |
| `captionless-video` | off | real tap | default | graceful error, not a stack trace |

Every cell asserts the method was `intercept` or `captions-intercept` (the
production path, never a fallback), and that the user's caption setting and
mute state were **restored** afterwards.

Cells are driven with **real adb taps on real elements**, located by
`uiautomator dump` (including the extension's own Summarize button, found by
its label). A synthetic `click()` carries no user activation, so it cannot test
the gesture-ordering bug class at all; a real tap can.

Each cell records the ref it was validated against:

```sh
node test/matrix-mweb.mjs                                  # must pass on HEAD
node test/matrix-mweb.mjs --ref 8dd1f0d --expect-fail      # must FAIL on the known-bad ref
```

`--ref` exports any git ref's `src/` with `git archive` and runs the matrix
against it. A regression test that does not fail on the commit that had the bug
is decoration, and `--expect-fail` is how we prove it is not.

## Running it

```sh
npm test                  # release gate, deterministic, no network beyond YouTube page loads
npm run canary            # desktop + mweb contract canaries against live YouTube
npm run matrix            # mweb state matrix on the emulator
npm run weekly            # everything, with a log and a pass/fail/inconclusive verdict
```

No LLM inference anywhere: the only model calls in the tree are answered by the
local mock server inside `test/smoke-full.mjs`. The weekly run costs nothing but
CPU.

### Exit codes

Suites distinguish three outcomes, because an unattended weekly run that cannot
tell "YouTube changed" from "the emulator did not boot" trains you to ignore it:

- `0` every contract check held.
- `1` a contract check FAILED. This is the real alarm: YouTube changed
  something. The failure names the assumption and the source that depends on it.
- `2` INCONCLUSIVE. The environment failed (no emulator, page never loaded, no
  playback). Not YouTube's fault, retry.

### The weekly job

`scripts/weekly-check.sh` runs the gate, the contract lint, both canaries and
the matrix, writes `~/Library/Logs/yap-sum/weekly-<stamp>.log`, keeps the last
12, and shuts the emulator down. On a contract failure it sends a Telegram
message through `clawd-agents/reynold/scripts/tg-notify.sh` if that exists.

```sh
npm run weekly:install    # launchd agent, Sundays 04:15
npm run weekly:uninstall
```

## Environment hazards the harness controls

Every one of these produced a false pass or a wasted run before it was handled,
and they are all things the old suites left uncontrolled:

- **Sticky captions.** The pref that hid the 0.5.5 bug. The matrix sets it per
  cell; the canary forces a known state and restores it.
- **Desktop UA override.** It lives in BOTH `user.js` and `prefs.js`; stripping
  only `user.js` leaves the persisted copy and you silently test the desktop
  site while believing you tested mweb. `android.setDesktopUa(false)` clears
  both.
- **The add-on install dialog.** Fenix shows "<name> was added / Update
  permissions and data preferences / OK" after every temporary install, and it
  eats the taps aimed at the player. Dismissed automatically after `start()`.
- **Tab reuse.** An Android VIEW intent for a URL that is already open focuses
  that tab instead of loading it, and a tab that predates the install has no
  content script. `open()` closes YouTube tabs first and adds a nonce.
- **Background tabs.** A restored tab can answer the command channel with stale
  data. The harness targets the active tab and reports `__visible`.
- **Autoplay policy.** Uncontrolled by default. The strict cell sets
  `media.autoplay.default=5` explicitly.
- **The Homebrew adb hangs at exec on this machine.** `test/lib/android.mjs`
  always uses the SDK's own adb.

## Layout

```
test/
  contract.mjs            the registry: every YouTube surface, why it matters
  lint-contract.mjs       gate check: nothing depends on YouTube unregistered
  canary-desktop.mjs      live desktop surfaces + the get_transcript capture path
  canary-mweb.mjs         live mweb surfaces + the caption-fetch behavior contract
  matrix-mweb.mjs         production path across caption/playback/autoplay states
  lib/harness.mjs         web-ext driver: desktop or Fenix, real src or any git ref,
                          injected probes, command channel, network observation
  lib/android.mjs         adb, emulator, uiautomator element taps, prefs, dialogs
  lib/report.mjs          contract-aware reporting and the three-way exit code
```

## Adding a check

1. Register the surface in `test/contract.mjs` with its severity and what
   breaks. The gate will tell you if you skipped this.
2. Assert it in the matching canary with `report.check("<contract-id>", ...)`.
   The id must exist or the contract lint fails.
3. If it is a regression, add a matrix cell with `knownBadRef` and prove it has
   teeth with `--ref <bad> --expect-fail`.

## The failure bundle

When extraction fails, the panel offers Copy debug. That bundle is the only
thing a field report gives us, so it carries what the last three failures
actually turned on, not just page structure:

- `captions`: does the player expose `toggleSubtitles`/`isSubtitlesOn`, what
  does `isSubtitlesOn()` say, is the captions `tracklist` readable yet, was the
  CC button in the DOM, and a `kick` record (which mechanism, prior state, how
  many attempts, whether it actually enabled, whether the module was ready).
  This is what turns "couldn't get a transcript" into "the toggle no-oped
  because the captions module had not loaded" without a repro session.
- `playback`: paused, muted, currentTime, readyState, and `advanced`, how far
  the video moved since the nudge. `paused` alone lies, because `play()` clears
  it synchronously even when autoplay then rejects.
- `anchors`: which registered button anchors matched and which did not, so a
  YouTube rename shows up as a named missing anchor instead of a mystery.
- `capture`: whether the capture was keyed to this video or came from the
  un-keyed fallback, and which video id it belonged to.

`smoke-full.mjs` asserts the bundle's shape in the gate and asserts it does NOT
contain the API key, since the user pastes it into a bug report.

## Status, 2026-07-30

Verified working:

- The contract lint runs in the gate (now 10 checks) and passes.
- `canary-mweb.mjs` is green at 19/19 against live YouTube, and on its first
  run it caught a genuine change: mobile YouTube replaced
  `ytm-like-button-renderer` with `like-button-view-model`, so the Summarize
  button had silently fallen back to a lower-priority anchor. Fixed in
  content.js and re-registered in the contract.
- `smoke-full.mjs` now requires the production intercept path.

The static invariants have been proven against the commits that had the bugs:

```
node test/lint-style.mjs --root <dir-with-src>
```

- `751bf17` (0.5.6 as first shipped) FAILS the caption-kick invariant: it
  toggled captions once and never re-read the state, which is exactly the bug
  found later that day. HEAD passes.
- `dc9d6f4` (0.5.4) FAILS the gesture-order invariant.

Not yet verified end to end:

- `canary-desktop.mjs` and `matrix-mweb.mjs` are written and syntax-clean but
  have not completed a green run. Both were blocked by the message-channel bug
  fixed in b948605; the mweb canary went green once that landed, so these two
  need a rerun and whatever shakes out. Run them individually
  (`npm run canary:desktop`, `node test/matrix-mweb.mjs --cell <id>`) before
  trusting a weekly result that includes them.
- The matrix cells' `knownBadRef` values have not yet been proven with
  `--ref <ref> --expect-fail`. Until they are, treat the cells as untested
  tests: that flag is the whole point of recording the bad ref.
