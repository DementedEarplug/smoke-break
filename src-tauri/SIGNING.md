# Signing, notarizing and shipping the macOS app

The repo builds an unsigned app. To give it to colleagues without asking them
to bypass Gatekeeper, sign it with your company's Developer ID, notarize it,
and push it with your MDM. Nothing in the project blocks this; the steps below
are all done on the build machine or in CI.

## What the config already does

- `tauri.conf.json` → `bundle.macOS.hardenedRuntime: true` (required for
  notarization). No entitlements file is needed: the app makes no JIT, no
  unsigned-library loads and no camera/mic/automation calls, and WKWebView runs
  its JavaScript in Apple's own processes.
- `bundle.macOS.signingIdentity` is `null` so the identity comes from the
  environment (below) and never sits in the repo.
- `app.macOSPrivateApi: true` stays. It is required for the transparent overlay
  window (`transparent: true`). It uses a private WebKit API, which Apple
  only rejects in the **Mac App Store**; Developer ID signing and
  notarization accept it. Don't plan on App Store distribution.
- The webview cannot open arbitrary URLs: meeting links go through the
  `open_meeting` command (`src/meeting.rs`), which only opens https Zoom links.

## 1. One-time setup

1. In your Apple Developer account (Organization, not Individual), create a
   **Developer ID Application** certificate. Export it with its private key as
   a `.p12` with a strong password.
2. Note your **Team ID** (10 characters, Membership page).
3. For notarization, create an **App Store Connect API key** (Users and Access
   → Integrations → Keys, role "Developer"). Download the `.p8` once; note the
   Key ID and Issuer ID. (An Apple ID + app-specific password also works, but
   the API key is better for CI.)
4. Decide on the bundle identifier. It is `com.smokebreak.desktop` today. If
   you change it to your own reverse-DNS name (e.g. `com.acme.smokebreak`),
   do it **before** the first rollout: the app's saved name, team and settings
   live in WebKit storage keyed by the identifier, so changing it later makes
   everyone onboard again.

## 2. Build-time settings for your company

Set these in the build environment (they are baked into the app):

| Variable | Example | Effect |
|---|---|---|
| `VITE_SERVER_URL` | `wss://breaks.acme.internal/ws` | Default hub. Must be `wss://` (the app refuses plain `ws://` except to localhost). |
| `VITE_HUB_TOKEN` | *(secret)* | Hub access token sent on join (the hub's `SMOKE_BREAK_ACCESS_TOKEN`). Anyone with the app can extract it, so treat it as "keeps strangers off the hub", not as a per-user credential; rotate it on the hub with each release if needed. People can override it in onboarding. |
| `SMOKE_BREAK_MEETING_HOST` | `acme.zoom.us` | Optional. The app then opens only links on exactly this host (it must still be a Zoom host). |

## 3. Sign and notarize

On a Mac with Xcode command line tools, in the repo root:

```sh
# Signing: either have the certificate in the login keychain and name it…
export APPLE_SIGNING_IDENTITY="Developer ID Application: Acme Inc (TEAMID1234)"
# …or (CI) pass the .p12 directly; Tauri imports it into a temporary keychain.
export APPLE_CERTIFICATE="$(base64 -i DeveloperID.p12)"
export APPLE_CERTIFICATE_PASSWORD="…"

# Notarization with an App Store Connect API key:
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export APPLE_API_KEY="ABCDE12345"
export APPLE_API_KEY_PATH="$PWD/AuthKey_ABCDE12345.p8"
#   (or: APPLE_ID, APPLE_PASSWORD (app-specific password), APPLE_TEAM_ID)

export VITE_SERVER_URL="wss://breaks.acme.internal/ws"
export VITE_HUB_TOKEN="…"

rustup target add aarch64-apple-darwin x86_64-apple-darwin   # once, for a universal build
npm ci
npx tauri build --target universal-apple-darwin
```

With those variables set, `tauri build` signs the app with the hardened
runtime, submits it to Apple's notary service, waits, and staples the ticket.
Output: `src-tauri/target/universal-apple-darwin/release/bundle/macos/Smoke Break.app`
and `…/bundle/dmg/Smoke Break_<version>_universal.dmg`.

Check the result before shipping:

```sh
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Smoke Break.app"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier|flags"   # expect flags=…(runtime)
spctl --assess --type execute --verbose "$APP"          # expect: accepted, source=Notarized Developer ID
xcrun stapler validate "$APP"
```

## 4. Distribute with MDM

- Wrap the app in a signed **.pkg** (most MDMs want one):
  ```sh
  productbuild --component "$APP" /Applications \
    --sign "Developer ID Installer: Acme Inc (TEAMID1234)" SmokeBreak-<version>.pkg
  xcrun notarytool submit SmokeBreak-<version>.pkg --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
  xcrun stapler staple SmokeBreak-<version>.pkg
  ```
  (The installer certificate is a second certificate type, "Developer ID
  Installer", from the same account.)
- Upload the pkg to your MDM (Jamf, Kandji, Intune, Mosyle…) and scope it.
- "Launch at login" uses a LaunchAgent. On macOS 13+ users get a "Background
  item added" notice; to pre-approve it, push a **Service Management – Managed
  Login Items** payload (`com.apple.servicemanagement`) with a rule for
  Team ID `TEAMID1234` (or bundle identifier).
- The app needs no privacy (TCC/PPPC) permissions: it reads the cursor position
  through the window system, which needs no Accessibility grant.

## 5. Shipping updates

The app has no built-in updater. For a managed fleet the simplest path is:

1. Bump `version` in `tauri.conf.json` (and `package.json`, `Cargo.toml`).
2. Build, sign, notarize and package as above.
3. Upload the new pkg to the MDM as a new version of the same title and let
   the MDM's patch policy install it (it replaces `/Applications/Smoke Break.app`).
   Security fixes then reach every machine on the MDM's next check-in, with no
   action from users.

If you ever ship outside MDM, add `tauri-plugin-updater`: generate an updater
key pair (`npx tauri signer generate`), put the public key in
`plugins.updater.pubkey`, serve `latest.json` over https, and build with
`TAURI_SIGNING_PRIVATE_KEY` set. Updater signatures are separate from (and in
addition to) Apple code signing.
