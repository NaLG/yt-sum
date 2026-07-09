# Testing yap-sum on an Android phone (before AMO signing)

**You can run yap-sum on your phone today, no AMO account needed — but only in
Firefox _Nightly_, not the regular Play-Store Firefox.**

## Why Nightly specifically

yap-sum extracts the transcript by watching YouTube's own network requests
(the `webRequest` API). I tested both Firefox builds on an Android emulator:

- **Regular Firefox (Play Store):** strips the `webRequest` permission from any
  add-on you install yourself (sideload). yap-sum loads, but transcript
  extraction can't work. Dead end until the extension is AMO-signed.
- **Firefox Nightly:** keeps `webRequest`. I installed the real yap-sum, opened
  a video, tapped **Summarize**, and it extracted the transcript and ran the
  whole pipeline — stopping only at "No API key configured" (expected; I hadn't
  set a key). With your Gemini key it will summarize, exactly like desktop.
  Screenshot of it working: `docs/mobile-summarize-button.png`.

So: **install Firefox Nightly for Android** (Play Store → "Firefox Nightly for
Developers", or from Mozilla directly). Keep your normal Firefox too.

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
