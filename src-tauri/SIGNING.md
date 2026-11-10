# Signing, notarizing and shipping the macOS app

The repo builds an unsigned app. To give it to colleagues without asking them
to bypass Gatekeeper, sign it with your company's Developer ID, notarize it,
and push it with your MDM. Nothing in the project blocks this; the steps below
are all done on the build machine or in CI.

**Build with `npm run desktop:build:enterprise`** (section 2). It refuses to
build until the hub and meeting host are set, locks the app to your hub, pins
the webviews' CSP to it, signs with your identity and then checks the built app.
A plain `npm run desktop:build` gives an app that can talk to any `wss:` hub.

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
  `open_meeting` command (`src-tauri/src/meeting.rs`), which only opens https Zoom
  meeting links (`/j/…`, `/w/…`, `/s/…`, `/wc/join/…`, `/my/…`).
- Each hub gets its own client id (derived from a random per-device secret
  and the hub address), its own saved team and its own access token. A server
  someone talks a user into entering learns nothing that works on yours.
- On macOS, access tokens typed into onboarding and the device secret the
  client ids are derived from are kept in the login Keychain (see
  [Where secrets are stored](#where-secrets-are-stored) below).

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

`npm run desktop:build:enterprise` (`scripts/enterprise-build.ts`) reads these
from the environment and bakes them into the app:

| Variable | Example | Effect |
|---|---|---|
| `VITE_SERVER_URL` | `wss://breaks.acme.internal/ws` | **Required.** Your hub. Must be `wss://` with a host name. |
| `SMOKE_BREAK_MEETING_HOST` | `acme.zoom.us` | **Required.** The app opens only meeting links on exactly this host (it must be a Zoom host). |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Acme Inc (TEAMID1234)` | Passed to `tauri build` as the signing identity (or use `APPLE_CERTIFICATE`, section 3). Without either the app is unsigned and the script says so. |
| `VITE_LOCK_SERVER` | *(set by the script)* | Always `1`: the app talks only to `VITE_SERVER_URL`. The Server field is hidden and any address saved earlier is ignored, so nobody can be talked into pointing the app at another server. |
| `VITE_HUB_TOKEN` | *(must be unset)* | The script refuses to build with a shared token. Each person enters their own (see [Access tokens](#access-tokens)). |

What the script does:

1. Refuses to start if a requirement is missing or wrong, and says what to set.
2. Writes a Tauri config override to
   `src-tauri/target/enterprise-build/tauri.override.json` that pins the CSP
   `connect-src` (both `csp` and `devCsp`) to exactly your hub's origin, e.g.
   `'self' ipc: http://ipc.localhost wss://breaks.acme.internal`, and names the
   signing identity when there is one.
3. Runs `tauri build --config <that file>` with `VITE_LOCK_SERVER=1`, plus any
   arguments you give after `--` (e.g. `-- --target universal-apple-darwin`).
4. Checks the built app: the pinned `connect-src` must be compiled into the
   executable and nothing of the default wide one (`wss:` to any host,
   `ws://localhost:*`…) may be left; the frontend must contain your hub
   address. If any check fails it says so and exits with an error: don't ship
   that build.
5. Prints a summary of what was pinned.

### Access tokens

The hub can require a token to connect at all. The app offers it when it opens
the connection (as a WebSocket subprotocol, and again in its first message), so
the hub turns strangers away before they can hold a connection open. When the
hub refuses, the app can't tell that apart from "unreachable"; after a couple
of failed attempts it says the hub needs a valid access token (or is
unreachable), offers to change the token, and keeps retrying more and more
slowly.

There are two kinds of token. **Use one or the other, not both:** the hub
refuses to start with both, because a shared token anyone can extract from the
app would let a person you removed straight back in.

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
- **The hub re-reads the tokens file within a few seconds, without a
  restart.** Deleting a person's line cuts them off: their open connections
  are dropped and new ones are refused. Nobody else is affected and no new app
  build is needed. See [A stolen laptop or a departed
  employee](#a-stolen-laptop-or-a-departed-employee).
- The label shows up in the hub's join log, so you can see whose token was used.
- Team owners see the label next to each name in their roster and in the
  "Waiting to join" list. The name is whatever someone typed; the label is
  whose token they connected with, so it is the one to trust. Removing someone
  who has a label removes all of that person's devices on the team.

**The shared build-time token (`VITE_HUB_TOKEN`).** Not for a company
rollout: `desktop:build:enterprise` refuses it. It is compiled into the app,
so everyone who has the app (or a copy of the `.dmg`) can extract it. It does
**not** identify anyone and can't be revoked for one person. It only suits a
small, informal setup built with plain `npm run desktop:build`, to keep
scanners off a hub that is reachable from outside. Don't rotate it "with each
release": every installed app keeps sending the old token until it is
replaced, so a rotation locks out everyone who hasn't updated yet.

**Delivering tokens with MDM.** The app reads the token the person typed into
onboarding; there is no managed-preferences key for it yet. Until there is,
send each person their token through your usual secret-sharing channel. (A
managed key would be the next step if you'd rather nobody types anything.)

### Where secrets are stored

On macOS two kinds of secret live in the login Keychain, not in the webview's
storage (a plain file other processes running as the user, and backups, can
read):

- each access token: service = the bundle identifier, account = the hub
  address;
- the device secret every client id is derived from, i.e. the proof of who
  someone is to a hub, team ownership included: same service, account
  `device-secret`. An existing install moves it out of web storage on its
  first start with this version, keeping every id (and team ownership) as it
  was.

The app always creates these items itself: it deletes any existing item and
adds a new one instead of updating it, so another process can't pre-create
the item with a lax access list and read what the app later stores. The
webview reaches them only through narrow commands (fixed service, the account
a checked hub address or the one fixed name, bounded sizes); it can't read or
write any other Keychain item. Other apps asking for these items get a
Keychain prompt. Trade-offs:

- The webview can still read the token and the secret through those
  commands; that is what it needs them for. The Keychain protects them at
  rest, not from a compromised app.
- The item's access list names the app's code signature. A signed release
  keeps the same identity across updates, so updates don't prompt. Unsigned or
  ad-hoc-signed dev builds change identity with every build, so macOS asks
  "Smoke Break wants to use your confidential information" after a rebuild.
  Click Always Allow, or sign dev builds with a fixed identity.
- If the Keychain refuses (the person clicked Deny), and on other platforms,
  the app falls back to web storage, as before.
- Check it by hand on a Mac: `cd src-tauri && cargo test -- --ignored
  keychain_round_trip` writes, reads and deletes test items.

### How the CSP pin works

`tauri.conf.json` lets the webviews open WebSockets to any `wss:` host (plus
localhost for development), because in a general build the Server field can
point anywhere. A locked build doesn't need that, so `desktop:build:enterprise`
pins `connect-src` to your hub, and even injected script can't talk to another
server. Tauri merges the override into `tauri.conf.json` (JSON Merge Patch:
only the keys given are replaced) and compiles the CSP into the app's
executable. `devCsp` is only used by `tauri dev`, but it is pinned too so the
wide list isn't in the binary at all.

The script checks the result itself. To look by hand (`$APP` is set in
step 3), every line this prints should end in your hub, none in a bare
`wss:` (string literals sit back to back in the binary, so the hub may run
straight into the next one, e.g. `wss://breaks.acme.internaldefault-src`):

```sh
grep -a -o "http://ipc.localhost [^ ;']*" "$APP"/Contents/MacOS/* | sort -u
```

If `cargo` builds the app without the Tauri CLI, the same override goes in the
`TAURI_CONFIG` environment variable:
`TAURI_CONFIG="$(cat src-tauri/target/enterprise-build/tauri.override.json)" cargo build --release`.

### A stolen laptop or a departed employee

Smoke Break has no accounts; what proves who someone is, is their access token
(per-user tokens) and the device secret on their Mac. So:

1. **Delete their line from the tokens file.** The hub picks the change up
   within seconds, drops their open connections and refuses new ones, so the
   laptop (or the person) can't reach the hub any more, whatever is stored
   on it. No restart, no new build, nobody else affected.
2. **If they owned a team,** nobody can change that team's settings until it
   has an owner again. The hub admin reassigns it on the hub machine with
   `node server/admin.ts set-owner <team-ref> <member-id>` (`list` shows
   both; stop the hub first, as the script says). The new owner can then
   remove the old account from the roster: that removes all of that person's
   devices and replaces the invite code, which they knew.
3. The admin script also has `unban` (to let someone back in who was removed
   by mistake) and `codes` (to look up a team's current invite code).
4. If the person comes back, give them a new token line; they enter the token
   in the app.

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
export SMOKE_BREAK_MEETING_HOST="acme.zoom.us"
# No VITE_HUB_TOKEN: the enterprise build refuses it. VITE_LOCK_SERVER=1 is set for you.

rustup target add aarch64-apple-darwin x86_64-apple-darwin   # once, for a universal build
npm ci
npm run desktop:build:enterprise -- --target universal-apple-darwin
```

With those variables set, `tauri build` (run by the script) signs the app with
the hardened runtime, submits it to Apple's notary service, waits, and staples
the ticket. The script then checks the pinned CSP and prints a summary.
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

- [ ] Built with `npm run desktop:build:enterprise`, and it ended with the
      "Enterprise build done. Pinned:" summary naming your hub
      (`wss://…`), your Zoom host and your signing identity.
- [ ] Access: per-user tokens in `SMOKE_BREAK_ACCESS_TOKENS_FILE`, one line
      per person, handed out privately. No shared `VITE_HUB_TOKEN`, and no
      shared token on the hub either.
- [ ] You know what to do when a laptop is lost or someone leaves (delete
      their line; reassign their teams with `server/admin.ts set-owner`).
- [ ] Signed with your Developer ID, notarized and stapled; `spctl --assess`
      says `accepted, source=Notarized Developer ID`.
- [ ] Packaged as a signed, notarized `.pkg` and uploaded to the MDM, with the
      Managed Login Items payload if you want "Launch at login" pre-approved.
- [ ] You know how the next version gets out: bump the version, build, sign,
      notarize, upload to the MDM as a new version of the same title and let
      its patch policy install it (section 5). Keep the bundle identifier and
      signing identity the same, or people onboard again and the Keychain
      asks about their saved token.
