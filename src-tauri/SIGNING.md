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
  `open_meeting` command (`src/meeting.rs`), which only opens https Zoom
  meeting links (`/j/…`, `/w/…`, `/s/…`, `/wc/join/…`, `/my/…`).
- Each hub gets its own client id (derived from a random per-device secret
  and the hub address), its own saved team and its own access token. A server
  someone talks a user into entering learns nothing that works on yours.
- On macOS, access tokens typed into onboarding are kept in the login
  Keychain (see [Access tokens](#access-tokens) below).

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
| `VITE_LOCK_SERVER` | `1` | The app talks only to `VITE_SERVER_URL`: the Server field is hidden and any address saved earlier is ignored, so nobody can be talked into pointing the app at another server. Always set it together with `VITE_SERVER_URL`. |
| `SMOKE_BREAK_MEETING_HOST` | `acme.zoom.us` | Optional. The app then opens only links on exactly this host (it must still be a Zoom host). |
| `VITE_HUB_TOKEN` | *(secret)* | Optional shared access token, sent only to the built-in hub. Read [Access tokens](#access-tokens) first; per-user tokens are better. |

### Access tokens

The hub can require a token to create or join a team. There are two kinds.

**Per-user tokens (recommended).** The hub reads a file of `label:token`
lines from `SMOKE_BREAK_ACCESS_TOKENS_FILE`, one line per person:

```text
alice:3f9c…  # openssl rand -hex 32
bob:a71e…
```

- Give each person their token privately (or deliver it with your MDM, below).
  They paste it once into the **Access token** field in onboarding. On macOS
  the app stores it in the login Keychain, filed under your hub's address, and
  sends it only to that hub.
- To cut someone off (they left, their laptop was lost), delete their line.
  Nobody else is affected and no new app build is needed. Check the README
  for whether your hub picks up file changes by itself or needs a restart.
- The label shows up in the hub's join log, so you can see whose token was used.

**The shared build-time token (`VITE_HUB_TOKEN`).** It is compiled into the
app, so everyone who has the app (or a copy of the `.dmg`) can extract it. It
is good for keeping strangers and scanners off a hub that is reachable from
outside; it does **not** identify anyone and can't be revoked for one
person. Don't rotate it "with each release": every installed app keeps
sending the old token until the MDM has replaced it, so a rotation locks out
everyone who hasn't updated yet. Change it only when it has leaked, and then
expect the lockout until the new build is everywhere.

You can combine both: the shared token as a fallback for the built-in hub,
and per-user tokens for people who should be revocable. A token typed into
onboarding takes precedence over the built-in one.

**Delivering tokens with MDM.** The app reads the token the person typed into
onboarding; there is no managed-preferences key for it yet. Until there is,
send each person their token through your usual secret-sharing channel. (A
managed key would be the next step if you'd rather nobody types anything.)

**Where the token is stored.** On macOS the token lives in the login Keychain
(service = the bundle identifier, account = the hub address), not in the
webview's storage, which is a plain file other processes running as the user
and backups can read. Other apps asking for the item get a Keychain prompt.
Trade-offs:

- The webview can still read the token through the app's `token_get` command;
  that is what it needs it for. The Keychain protects the token at rest, not
  from a compromised app.
- The item's access list names the app's code signature. A signed release
  keeps the same identity across updates, so updates don't prompt. Unsigned or
  ad-hoc-signed dev builds change identity with every build, so macOS asks
  "Smoke Break wants to use your confidential information" after a rebuild.
  Click Always Allow, or sign dev builds with a fixed identity.
- If the Keychain refuses (the person clicked Deny), and on other platforms,
  the app falls back to web storage under the same per-hub key, as before.
- Check it by hand on a Mac: `cd src-tauri && cargo test -- --ignored
  keychain_round_trip` writes, reads and deletes a test item.

### Pin the CSP to your hub

`tauri.conf.json` lets the webviews open WebSockets to any `wss:` host (plus
localhost for development), because the Server field can point anywhere. With
`VITE_LOCK_SERVER=1` it doesn't need to: pin `connect-src` to your hub at build
time, so even injected script can't talk to another server. Tauri merges extra
config into `tauri.conf.json` (JSON Merge Patch: only the keys you give are
replaced), and the CSP is compiled into the app.

Put this in a file next to `tauri.conf.json`, e.g. `src-tauri/tauri.acme.conf.json`
(`devCsp` is only used by `tauri dev`, but pinning it too keeps the wide list out
of the binary altogether):

```json
{
  "app": {
    "security": {
      "csp": {
        "connect-src": "'self' ipc: http://ipc.localhost wss://breaks.acme.internal"
      },
      "devCsp": {
        "connect-src": "'self' ipc: http://ipc.localhost wss://breaks.acme.internal"
      }
    }
  }
}
```

and build with it:

```sh
npx tauri build --target universal-apple-darwin --config src-tauri/tauri.acme.conf.json
```

`--config` also takes the JSON inline. When `cargo` builds the app without the
Tauri CLI, put the same JSON in the `TAURI_CONFIG` environment variable
(`TAURI_CONFIG="$(cat src-tauri/tauri.acme.conf.json)" cargo build --release`).

Keep `'self' ipc: http://ipc.localhost` (the windows need them to talk to the
app itself) and write the hub as `wss://host` or `wss://host:port`. After the
build (step 3; `$APP` is set there), every line this prints should end in your
hub, none in a bare `wss:`:

```sh
grep -a -o "http://ipc.localhost [^ ;]*" "$APP"/Contents/MacOS/* | sort -u
```

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
export VITE_LOCK_SERVER=1
export SMOKE_BREAK_MEETING_HOST="acme.zoom.us"
# export VITE_HUB_TOKEN="…"   # optional; see "Access tokens"

rustup target add aarch64-apple-darwin x86_64-apple-darwin   # once, for a universal build
npm ci
npx tauri build --target universal-apple-darwin --config src-tauri/tauri.acme.conf.json
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

## Before you deploy

- [ ] Built with `VITE_SERVER_URL=wss://…` (your hub, `wss://`, not `ws://`).
- [ ] Built with `VITE_LOCK_SERVER=1`.
- [ ] Built with `SMOKE_BREAK_MEETING_HOST` set to your company's Zoom host
      (e.g. `acme.zoom.us`).
- [ ] CSP `connect-src` pinned to your hub (`--config`, above) and checked with `grep`.
- [ ] Access: per-user tokens in `SMOKE_BREAK_ACCESS_TOKENS_FILE` handed out
      to each person, and/or a shared `VITE_HUB_TOKEN` you are prepared to
      keep until it leaks (not rotated per release).
- [ ] Signed with your Developer ID, notarized and stapled; `spctl --assess`
      says `accepted, source=Notarized Developer ID`.
- [ ] Packaged as a signed, notarized `.pkg` and uploaded to the MDM, with the
      Managed Login Items payload if you want "Launch at login" pre-approved.
- [ ] You know how the next version gets out: bump the version, build, sign,
      notarize, upload to the MDM as a new version of the same title and let
      its patch policy install it (section 5). Keep the bundle identifier and
      signing identity the same, or people onboard again and the Keychain
      asks about their saved token.
