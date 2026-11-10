# Signing, notarizing and shipping the macOS app

The repo builds an unsigned app. To give it to colleagues without asking them
to bypass Gatekeeper, sign it with your company's Developer ID, notarize it,
and push it with your MDM. Nothing in the project blocks this; the steps below
are all done on the build machine or in CI.

**Build with `npm run desktop:build:enterprise`** (section 2). It refuses to
build until the hub and meeting host are set, locks the app to your hub, pins
the webviews' CSP to it, signs with your identity and then checks the built app.
A plain `npm run desktop:build` gives an app that can talk to any `wss:` hub.
**Before handing an app to MDM, check it** with
`npm run desktop:build:enterprise -- --check <path/to/Smoke Break.app>`
([Checking a built app](#checking-a-built-app)).

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
- On macOS, access tokens, the device secret and any client id pinned to a hub
  are kept in the user's login Keychain, and the device secret never leaves
  the app's native code (see [Where secrets are stored](#where-secrets-are-stored)).
- One running app per user: a second launch asks the first to open its
  settings window and quits. The lock and the socket for that live in the
  app's data folder (`~/Library/Application Support/<bundle id>`, made
  readable by the user only), not in `/tmp`, so another account on the Mac
  can't stop the app from starting.

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
4. Checks the built app, with the same checks as `--check` (below) plus one:
   the frontend in `dist/` must contain your hub address. It prints the
   pass/fail table; if any check fails it exits with an error: don't ship that
   build.
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
  sends it only to that hub. If the Keychain won't take it (locked, or the
  person clicked Deny), the app uses it until it quits, says so, and asks for
  it again next time; it never writes it anywhere else.
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

**On macOS**, in the user's **login keychain** (`~/Library/Keychains/login.keychain-db`),
service = the bundle identifier, one generic-password item each:

| Account | Holds | Goes to the webview? |
|---|---|---|
| the hub address, e.g. `wss://breaks.acme.internal/ws` | that hub's access token | yes: it reads it to connect |
| `device-secret` | the random device secret every client id is derived from | **no**: the app's native code derives the id for a hub (HMAC-SHA256) and hands the webview only that id |
| `client-id@<hub address>` | an id pinned to that hub: the one id older versions used for every hub, kept for the hub configured at upgrade so nobody loses their place or team ownership | only that id |

- The app opens the login keychain by its path. It never writes to "the
  default keychain" or searches the keychain list, which another process
  running as the user could point at a keychain whose password it knows.
  If the login keychain can't be opened, the app says so and writes nothing
  to disk.
- The app always creates these items itself: it deletes any existing item and
  adds a new one instead of updating it, so another process can't pre-create
  an item with a lax access list and read what the app later stores. Each new
  item's access list names only Smoke Break (by its code signature); other
  apps asking for it get a Keychain prompt.
- The webview reaches them only through narrow commands: fixed service, the
  account a checked hub address (or `client-id@` plus one, or the one fixed
  name), bounded and checked values. It can't read or write any other item,
  and has no command that returns the device secret.
- An existing install moves what older versions kept in web storage (the
  device secret, pinned ids, access tokens) into the Keychain on its first
  start with this version. Each piece is deleted from web storage only after
  the Keychain confirmed it, and every id stays the same, so nobody loses
  their place or ownership.
- **If the Keychain refuses** (locked, or the person clicked Deny), the app
  does not fall back to web storage. A token is used until the app quits and
  the app says it will have to be entered again. For the identity, it shows
  the error and a Try again button; it never makes up a new identity, which
  would silently lose team ownership. Whatever an older version left in web
  storage stays there until the Keychain takes it: the identity when the
  person presses Try again, a leftover token on the next start (it is used
  from memory meanwhile).

**Still in web storage** (WebKit's storage for the app, under
`~/Library/WebKit/`, readable by any process running as the user): the name
someone typed, the hub address (unless locked), the **invite code** of their
team on each hub, appearance settings, the pack's position, and two
bookkeeping entries (that the device secret is in the Keychain, and for which
hubs a pinned id is). Once the move above is done, no token, device secret
or client id.

**Without a Keychain** (the browser version, and desktop builds for other
platforms) tokens, the device secret and pinned ids stay in web storage, and
the token field says so. Don't use such builds where that matters.

**What that protects against, and what it doesn't:**

- **Another user account on the same Mac** (not an administrator) can't read
  any of it: `~/Library` is readable by its owner only. It also can't stop the
  app from starting (the single-instance lock is in the user's own data
  folder) or talk to the running app (the app checks the other end's user id).
  An administrator can read the user's files and, while the app runs, its
  memory; the login keychain file is still encrypted with the user's login
  password.
- **Another process running as the same user** (malware, a rogue app) is
  *not* stopped by any of this, only slowed down. It can read web storage
  (name, invite codes); read the clipboard when a token is pasted; watch or
  script the UI if the user granted it Accessibility access; make the app
  lose its identity (e.g. by editing web storage), which is a denial of
  service, not a takeover; and with an unsigned or ad-hoc-signed build, get
  its own code into the app and read whatever the app can. What it can't do
  is read the Keychain items quietly: their access list makes macOS ask the
  user first. That raises the bar; it is not a boundary against malware
  running as the user. A Developer ID signature with the hardened runtime
  (section 3) also makes macOS refuse to let other processes attach to or
  inject code into the app.
- **A stolen laptop, locked or off**: with FileVault on, nothing is readable
  without the user's password; the login keychain is additionally encrypted
  with the login password. Without FileVault, web storage (name, invite codes)
  can be read from the disk; the Keychain items can't without the login
  password. Make FileVault mandatory through MDM.
- **A stolen laptop that is unlocked**, or a login password the thief knows:
  assume everything is readable, tokens and device secret included. **Revoke
  the token** (delete the person's line in the tokens file); the hub then
  refuses that laptop whatever it holds. See
  [A stolen laptop or a departed employee](#a-stolen-laptop-or-a-departed-employee).
- **Script running in the webview** (if a bug ever let a hub inject some):
  it can read the token for a hub and ask for this device's id for a hub,
  because the app itself needs both. It can't get the device secret, so it
  can't derive ids later, elsewhere. In a locked build the CSP only lets it
  talk to your hub.

Trade-offs and checks:

- The item's access list names the app's code signature. A signed release
  keeps the same identity across updates, so updates don't prompt. Unsigned or
  ad-hoc-signed dev builds change identity with every build, so macOS asks
  "Smoke Break wants to use your confidential information" after a rebuild.
  Click Always Allow, or sign dev builds with a fixed identity.
- The Keychain used is the classic file-based login keychain. The newer
  data-protection keychain would tie the items to the app's signing team, but
  macOS only lets apps with a keychain-access-group entitlement (that is, a
  signed app with a provisioning profile) use it, and the app has to work
  unsigned too.
- An install whose items an older version wrote to a *different* default
  keychain (only if someone had changed the default) won't find them in the
  login keychain: the person enters their token again, and gets a new device
  secret, so a team they owned needs `server/admin.ts set-owner`.
- `cd src-tauri && cargo test` checks the derivation against the cases in
  `shared/client-id-vectors.json` (the TypeScript tests check the same ones)
  and the single-instance lock. `cargo test -- --ignored temp_keychain_round_trip`
  exercises the Keychain code against a throwaway keychain file it creates
  and deletes (macOS adds it to the keychain list while the test runs).

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

### Checking a built app

The last step before handing the app to MDM, and the one to repeat on exactly
the copy you hand over (it builds nothing and changes nothing):

```sh
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Smoke Break.app"
VITE_SERVER_URL="wss://breaks.acme.internal/ws" SMOKE_BREAK_MEETING_HOST="acme.zoom.us" \
  npm run desktop:build:enterprise -- --check "$APP"
```

It prints a table and exits non-zero if any line says FAIL:

| Check | Passes when |
|---|---|
| Build record | the executable carries the record `src-tauri/build.rs` writes at build time (hub, server lock, whether a shared token was set, meeting host; never the token itself) |
| Hub address | it is a `wss://` hub, and the one in `VITE_SERVER_URL` if you set it |
| Server lock | the app was built with `VITE_LOCK_SERVER=1` |
| Shared access token | `VITE_HUB_TOKEN` was empty |
| Meeting host pinned | a Zoom host is pinned and is in the executable (and matches `SMOKE_BREAK_MEETING_HOST` if set) |
| CSP connect-src | every `connect-src` compiled into the executable is exactly `'self' ipc: http://ipc.localhost <your hub origin>`, with nothing of the wide default left |
| Signed | signed with a real identity (not unsigned or ad-hoc; `--allow-unsigned` turns this into a warning, for test builds only) |
| `codesign --verify --deep --strict` | the signature is valid for everything in the bundle |
| Hardened runtime | the code directory flags include `runtime` |
| Notarization | if notarized (stapled ticket, or `spctl` says so): `spctl --assess` accepts it. Not notarized is a warning. On a Mac with Gatekeeper turned off `spctl` accepts anything, so this fails there: run the check on a Mac with Gatekeeper on |

The record is what the build was configured with; the frontend itself is
compressed inside the executable, so `--check` can't read the hub address out
of it. The enterprise build checks that in `dist/` right after building.

## 4. Distribute with MDM

- Run `--check` on the app first ([Checking a built app](#checking-a-built-app)).
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
- [ ] Signed with your Developer ID, notarized and stapled, and
      `npm run desktop:build:enterprise -- --check "$APP"` passes on the copy
      you hand to the MDM.
- [ ] Packaged as a signed, notarized `.pkg` and uploaded to the MDM, with the
      Managed Login Items payload if you want "Launch at login" pre-approved.
- [ ] You know how the next version gets out: bump the version, build, sign,
      notarize, upload to the MDM as a new version of the same title and let
      its patch policy install it (section 5). Keep the bundle identifier and
      signing identity the same, or people onboard again and the Keychain
      asks about their saved token.
