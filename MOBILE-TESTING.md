# Installing yap-sum on an Android phone

**Once the `.xpi` is AMO-signed, it installs on regular Play-Store Firefox for
Android — no Nightly, no about:config.** (Signing: see the bottom section.)

## Installing a signed .xpi — the key point

You **cannot install an add-on by "opening" the .xpi file**. Firefox for Android
has no file-association for that: tapping/opening an .xpi just **downloads** it.
That's expected — there is no setting to change.

Install it from *inside* Firefox instead:

1. Get the signed `.xpi` onto the phone (download it in Firefox, or transfer it —
   it lands in Downloads).
2. **Unlock the developer menu** (this is the gate — "Install extension from
   file" is hidden until you do it): **⋮ → Settings → About Firefox**, then tap
   the **Firefox logo / wordmark ~5 times** until it says debug is enabled.
3. Back in **Settings → (Advanced) Extensions**, the **"Install extension from
   file"** option now appears (via the page's ⋮ / a new entry). Pick the `.xpi`
   from Downloads → **Add** → grant the permission prompt. That prompt is where a
   *signed* install gets `webRequest` (a plain dev/temp install doesn't).
4. Use it: open a YouTube video → tap **Summarize**. (Confirmed on a real phone:
   works on the mobile page directly — no "Desktop site" needed once installed as
   a real signed add-on; the network intercept grabs the transcript.) Set your
   provider + API key first via the yap-sum toolbar popup → Settings.

## No-signing alternative: Firefox Nightly

If you ever want to test an *unsigned* build without signing it, only **Firefox
Nightly** works (regular Firefox strips `webRequest` from unsigned sideloads;
Nightly keeps it — verified on the emulator: the real yap-sum injected its
Summarize button on desktop-site YouTube and extracted the transcript, stopping
only at "No API key". Screenshot: `docs/mobile-summarize-button.png`). On
Nightly you also need `about:config → xpinstall.signatures.required = false`
before the install-from-file step above. For a signed build this is unnecessary.

## One YouTube caveat (same as desktop findings)

YouTube's **mobile** site (m.youtube.com) exposes no transcript at all. In
Nightly, turn on **Menu (⋮) → Desktop site** on the video page — then the
Summarize button appears in the action row and extraction works. yap-sum shows a
reminder about this if you forget.

---

## Route A — Standalone install (recommended: no laptop, permanent)

This puts yap-sum on your phone by itself; it survives restarts.

1. **Get the add-on file onto the phone.** Build it (`npm run build` →
   `dist/yap-sum-0.3.0.zip`) and rename/copy it to `yap-sum-0.3.0.xpi`
   (`.xpi` is just a renamed zip). Email/AirDrop/USB it to the phone, or host it
   and download it in Nightly. It lands in your Downloads.
2. **Allow unsigned add-ons.** In Nightly: `⋮ → Settings → About Firefox
   Nightly`, then tap the Firefox **logo 5 times** to unlock the secret
   developer menu. Back in Settings a **"Custom Add-on collection"** /
   **debug** section appears. (On current Nightly there's also
   `⋮ → Settings → Advanced → "Install extension from file"`.)
   - Also flip the signature check off: address bar → `about:config` →
     search `xpinstall.signatures.required` → set to **false**.
3. **Install it.** `⋮ → Settings → Extensions → (⋮ top-right) → "Install
   extension from file"` → pick `yap-sum-0.3.0.xpi` from Downloads → **Add**.
   Grant the permission prompt (this is where Nightly, unlike release, actually
   gives it `webRequest`).
4. **Use it.** Open a YouTube video → `⋮ → Desktop site` → tap **Summarize**.
   Set your provider + API key first via the yap-sum toolbar popup → Settings
   (same options page as desktop).

> Honesty note: I verified the underlying capability end-to-end on the emulator
> (Nightly grants `webRequest`; the real extension extracts + runs). I did **not**
> click through every one of these exact Settings taps on the emulator — the
> menu is fiddly to drive headless — so if a label is named slightly differently
> on your Nightly build, it'll be one of the nearby Extensions/Advanced items.
> Route B below is the one I ran start-to-finish.

## Route B — USB + web-ext (what I verified completely; temporary)

Needs the phone tethered to the Mac; the add-on unloads when you close Firefox.
Good for a quick "does it work" look. This is the exact path I confirmed.

1. On the phone (Nightly): `Settings → About → tap logo 5×` to enable dev menu,
   then `Settings → Remote debugging via USB → ON`. Enable Android **USB
   debugging** (Developer options) and plug in; accept the on-device prompt.
2. On the Mac:
   ```
   . scripts/android-env.sh          # puts the working adb on PATH
   adb devices                       # confirm your phone shows as "device"
   YAPSUM_FIREFOX_APK=org.mozilla.fenix \
     web-ext run --source-dir src --target firefox-android \
     --android-device <your-device-id> --firefox-apk org.mozilla.fenix
   ```
   (`org.mozilla.fenix` is Nightly's package name.)
3. Open a YouTube video on the phone → `⋮ → Desktop site` → **Summarize**.

---

## The real fix (later): AMO unlisted signing

Both routes above are workarounds for Nightly. To run yap-sum on **regular**
Firefox for Android permanently, the `.xpi` must be signed by Mozilla:

- Free AMO account → generate API credentials (JWT issuer + secret).
- `web-ext sign --api-key=… --api-secret=… --channel=unlisted --source-dir src`
  returns a signed `.xpi` that installs in normal Firefox (desktop and Android)
  without any about:config changes — and keeps `webRequest`.

That's task #6's prerequisite. Once signed, we can also pursue the seamless
m.youtube.com experience (hidden desktop-frame extraction).
