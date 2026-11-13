# Signing, notarizing and shipping the macOS app

The repo builds an unsigned app. To give it to colleagues without asking them
to bypass Gatekeeper, sign it with your company's Developer ID, notarize it,
and push it with your MDM. Nothing in the project blocks this. You do every
step below on the build machine or in CI.

**Build with `npm run desktop:build:enterprise`** (section 2). It refuses to
build until you set the hub and meeting host. It locks the app to your hub and
pins the webviews' CSP `connect-src` to it. It signs with your identity, when
you give one, and then checks the built app. A plain `npm run desktop:build`
gives an app that can talk to any `wss:` hub (and to a plain `ws:` one on the
same Mac).
**Before handing an app to MDM, check it** with
`npm run desktop:build:enterprise -- --check <path/to/Smoke Break.app>`
([Checking a built app](#checking-a-built-app)).

## What the config already does

- `tauri.conf.json` sets `bundle.macOS.hardenedRuntime: true`, which
  notarization requires. The app needs no entitlements file. It makes no JIT,
  no unsigned-library loads and no camera, microphone or automation calls, and
  WKWebView runs its JavaScript in Apple's own processes.
- `bundle.macOS.signingIdentity` is `null`, so the identity comes from the
  environment (below) and the repo never contains it.
- `app.macOSPrivateApi: true` stays. The transparent overlay window
  (`transparent: true`) requires it. It uses a private WebKit API. Apple
  rejects that only in the **Mac App Store**, and Developer ID signing and
  notarization accept it. Don't plan on App Store distribution.
- The webview cannot open arbitrary URLs. Meeting links go through the
  `open_meeting` command (`src-tauri/src/meeting.rs`), which opens only https
  Zoom meeting links (`/j/…`, `/w/…`, `/s/…`, `/wc/join/…`, `/my/…`).
- Each hub gets its own client id, its own saved team and its own access
  token. The app derives the client id from a random per-device secret and the
  hub address. If someone talks a user into entering another server, that
  server learns nothing that works on yours.
- On macOS, the app keeps access tokens, the device secret and any client id
  pinned to a hub in the user's login Keychain. The device secret never leaves
  the app's native code (see [Where secrets are stored](#where-secrets-are-stored)).
- In a locked build (the enterprise one), the native side is locked too. Every
  command that takes a hub address (reading or saving a token, asking for this
  device's id, pinning an older id) refuses any hub but the built-in one
  (`src-tauri/src/lock.rs`).
- Each window may call only what it needs. `src-tauri/capabilities/overlay.json`
  lists every permission of the pack. The pack may show, hide, move and size
  its own window, let clicks through, read the cursor position and the
  screens, open a meeting, ask for the settings window, set the tray's
  do-not-disturb, and read the token and its id. `capabilities/panel.json`
  lists every permission of the settings window, which may read and save the
  token and read its id. Both windows may send and listen to events (any event
  name, to or from either window), and move an older version's identity into
  the Keychain. The pack handles its window only through the app's own
  `window_*` commands, which act on the window that calls them and no other.
  Tauri's own window commands act on whichever window their `label` argument
  names, and a capability can't confine them to the caller, so neither window
  gets any of them. The app grants nothing else of Tauri's (menus, tray,
  paths, creating windows or webviews, opening URLs), and each of the app's
  commands checks the calling window again. Release builds have no web
  inspector (Tauri's `devtools` feature is off), and `withGlobalTauri` is off.
- Only one copy of the app runs per user. A second launch asks the first to
  open its settings window, then quits. The lock and the socket for this live
  in the app's data folder (`~/Library/Application Support/<bundle id>`, which
  the app makes readable by the user only), not in `/tmp`. So another account
  on the Mac can't stop the app from starting.

## 1. One-time setup

1. In your Apple Developer account (Organization, not Individual), create a
   **Developer ID Application** certificate. Export it with its private key as
   a `.p12` with a strong password.
2. Note your **Team ID** (10 characters, on the Membership page).
3. For notarization, create an **App Store Connect API key** with the role
   "Developer". You find it in Users and Access, under Integrations, then Keys.
   Download the `.p8` once, and note the Key ID and Issuer ID. An Apple ID with
   an app-specific password also works, but the API key is better for CI.
4. Decide on the bundle identifier. Today it is `com.smokebreak.desktop`. If
   you change it to your own reverse-DNS name (for example
   `com.acme.smokebreak`), do it **before** the first rollout. The app keeps
   the saved name, team and settings in WebKit storage under the identifier,
   so changing it later makes everyone onboard again.

## 2. Build-time settings for your company

`npm run desktop:build:enterprise` (`scripts/enterprise-build.ts`) reads these
variables from the environment and builds them into the app:

| Variable | Example | Effect |
|---|---|---|
| `VITE_SERVER_URL` | `wss://breaks.acme.internal/ws` | **Required.** Your hub. It must be `wss://` with a host name. |
| `SMOKE_BREAK_MEETING_HOST` | `acme.zoom.us` | **Required.** The app opens meeting links only on exactly this host, which must be a Zoom host. |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Acme Inc (TEAMID1234)` | The script passes it to `tauri build` as the signing identity. You can use `APPLE_CERTIFICATE` instead (section 3). Without either, the app is unsigned and the script says so. |
| `VITE_LOCK_SERVER` | *(set by the script)* | Always `1`. The app talks only to `VITE_SERVER_URL`. The app hides the Server field and ignores any address saved earlier, so nobody can talk a user into pointing the app at another server. The native commands answer for that hub only. |
| `VITE_HUB_TOKEN` | *(must be unset)* | The script refuses to build with a shared token. Each person enters their own (see [Access tokens](#access-tokens)). |

What the script does:

1. Refuses to start if a requirement is missing or wrong, and says what to set.
2. Writes a Tauri config override to
   `src-tauri/target/enterprise-build/tauri.override.json`. The override pins
   the CSP `connect-src` (both `csp` and `devCsp`) to exactly the app and your
   hub's origin, for the example hub `'self' ipc: wss://breaks.acme.internal`.
   It also names the signing identity when there is one. The script writes
   each CSP as one policy string (`connect-src …; default-src …; …`, with the
   other directives as in `tauri.conf.json`), so `--check` can read where
   `connect-src` ends in the binary.
3. Runs `tauri build --config <that file>` with `VITE_LOCK_SERVER=1`, plus any
   arguments you give after `--` (for example
   `-- --target universal-apple-darwin`).
4. Checks the built app with the same checks as `--check` (below), plus one
   more. The frontend in `dist/` must contain your hub address. The script
   prints a table with a pass or fail for each check. If any check fails, it
   exits with an error. Don't ship that build.
5. Prints a summary of what was pinned.

### Access tokens

The hub can require a token to connect at all. The app offers the token when
it opens the connection, as a WebSocket subprotocol, and again in its first
message. So the hub turns strangers away before they can hold a connection
open. When the hub refuses, the app can't tell that apart from an unreachable
hub. After a couple of failed attempts, the app says the hub needs a valid
access token (or is unreachable) and offers to change the token. It keeps
retrying, with longer and longer waits between attempts.

There are two kinds of token. **Use one or the other, not both.** The hub
refuses to start with both. Anyone can extract a shared token from the app, so
it would let a person you removed straight back in.

**Per-user tokens (recommended).** The hub reads a file of `label:token`
lines from `SMOKE_BREAK_ACCESS_TOKENS_FILE`, one line per person:

```text
alice:3f9c…  # openssl rand -hex 32
bob:a71e…
```

- Give each person their token privately. MDM can't deliver it yet (see below).
  They paste it once into the **Access token** field in onboarding. On macOS
  the app stores it in the login Keychain, filed under your hub's address, and
  sends it only to that hub. If the Keychain won't take it (it is locked, or
  the person clicked Deny), the app uses the token until it quits, says so,
  and asks for it again next time. It never writes the token anywhere else.
- **The hub re-reads the tokens file within a few seconds, without a
  restart.** Deleting a person's line cuts them off. The hub drops their open
  connections and refuses new ones. Nobody else is affected, and you need no
  new app build. See [A stolen laptop or a departed
  employee](#a-stolen-laptop-or-a-departed-employee).
- The hub's join log shows the label, so you can see whose token someone used.
- Team owners see the label next to each name in their roster and in the
  "Waiting to join" list. The name is whatever someone typed. The label is
  whose token they connected with, so the label is the one to trust. Removing
  someone who has a label removes all of that person's devices on the team.

**The shared build-time token (`VITE_HUB_TOKEN`).** It is not for a company
rollout, and `desktop:build:enterprise` refuses it. The build compiles it into
the app, so everyone who has the app (or a copy of the `.dmg`) can extract it.
It does **not** identify anyone, and you can't revoke it for one person. It
suits only a small, informal setup built with plain `npm run desktop:build`,
where it keeps scanners off a hub that is reachable from outside. Don't rotate
it "with each release". Every installed app keeps sending the old token until
it is replaced, so a rotation locks out everyone who hasn't updated yet.

**Delivering tokens with MDM.** The app reads the token the person typed into
onboarding. There is no managed-preferences key for it yet. Until there is,
send each person their token through your usual secret-sharing channel. A
managed key would be the next step if you'd rather nobody typed anything.

### Where secrets are stored

**On macOS**, the app keeps them in the user's **login keychain**
(`~/Library/Keychains/login.keychain-db`), with the bundle identifier as the
service and one generic-password item each:

| Account | Holds | Goes to the webview? |
|---|---|---|
| the hub address, for example `wss://breaks.acme.internal/ws` | that hub's access token | yes, the webview reads it to connect |
| `device-secret` | the random device secret that every client id is derived from | **no**. The app's native code derives the id for a hub (HMAC-SHA256) and hands the webview only that id. |
| `client-id@<hub address>` | an id pinned to that hub. Older versions used this one id for every hub. The app keeps it for the hub configured at upgrade, so nobody loses their place or team ownership. | only that id |

- The app opens the login keychain by its path. It never writes to "the
  default keychain" or searches the keychain list, because another process
  running as the user could point those at a keychain whose password it
  knows. If the app can't open the login keychain, it says so and puts these
  secrets nowhere else. It keeps a token in memory until the app quits.
- The app always creates these items itself. It deletes any existing item and
  adds a new one instead of updating it. So another process can't pre-create
  an item with a lax access list and read what the app later stores. Each new
  item's access list names only Smoke Break, by its code signature. Other apps
  that ask for an item get a Keychain prompt.
- The webview reaches these items only through narrow commands. The service
  is fixed. The account is a checked hub address, `client-id@` plus a checked
  hub address, or the one fixed name. The values are bounded and checked. The
  webview can't read or write any other item, and it has no command that
  returns the device secret. Only the settings window may save a token, and in
  a locked build only for the built-in hub.
- On its first start with this version, an existing install moves what older
  versions kept in web storage (the device secret, pinned ids, access tokens)
  into the Keychain. The settings window moves the tokens, and it starts with
  the app. The app deletes each piece from web storage only after the Keychain
  confirms it. Every id stays the same, so nobody loses their place or
  ownership. A locked build drops ids and tokens that an older, unlocked
  version kept for other hubs, because it can never use them. Older versions
  also kept do-not-disturb under a key named after the client id. At startup
  the app deletes every such key and moves the setting to a key named after
  the hub. If the identity doesn't load, do-not-disturb is just off.
- **If the Keychain refuses** (it is locked, or the person clicked Deny), the
  app does not fall back to web storage. It uses a token until the app quits,
  and says the person will have to enter it again. For the identity, it shows
  the error and a Try again button. It never makes up a new identity, which
  would silently lose team ownership. Whatever an older version left in web
  storage stays there until the Keychain takes it. For the identity, that
  happens when the person presses Try again. For a leftover token, it happens
  on the next start, and the app still uses the token meanwhile.

#### What is stored where on the Mac

Once the move above is done, the app stores exactly what the table below
lists. `src/webStorage.test.ts` checks this. It runs onboarding, joining,
rotating the code, do-not-disturb and the look through both windows. The test
fails if the app writes anything else, or if a token, the device secret or a
client id reaches web storage or an event.

| Where | What | Proves who you are? |
|---|---|---|
| Login keychain, with the bundle id as the service | `<hub address>` holds that hub's access token | **yes** |
| Login keychain | `device-secret` holds the secret that every client id is derived from. It never leaves the native code. | **yes** |
| Login keychain | `client-id@<hub address>` holds an id pinned to that hub (only on installs upgraded from before per-hub ids) | **yes** |
| The app's memory, until it quits | the device secret (loaded once per run), and a token the Keychain refused to store | **yes** |
| Web storage, which is `localStorage` in `~/Library/WebKit/` (readable by any process running as the user) | `sb:name` and `sb:lastName` hold the name typed in | no |
| Web storage | `sb:server` holds the hub address typed in (unlocked builds only) | no |
| Web storage | `sb:team@<hub address>` holds the invite code of the team on that hub | no, but it lets someone ask to join the team |
| Web storage | `sb:dnd@<hub address>` holds whether do-not-disturb is on or off | no |
| Web storage | `sb:appearance` holds the size, break style and skins | no |
| Web storage | `sb:overlayPos` holds where the pack is on the screen | no |
| Web storage | `sb:deviceSecretInKeychain` and `sb:pinnedIdsInKeychain` record that the device secret is in the Keychain, and for which hub addresses a pinned id is | no |
| `sessionStorage` | nothing (the desktop app doesn't use it) | |
| Events between the two windows | `identity-changed`, `identity-ready` (no payload), `appearance-changed` (size, style, skins), `dnd` (on or off, from the tray to the pack) | no |
| `~/Library/Application Support/<bundle id>/` (user only, 0700) | `instance.lock` and `instance.sock`, the single-instance lock | no |

Until the move has worked, web storage can still hold what an older version
put there: `sb:token@<hub>`, `sb:deviceSecret`, `sb:clientId@<hub>` (and
`sb:clientId`, which the app renames to it at the first start),
`sb:dnd:<client id>`.

**Without a Keychain** (the browser version, and desktop builds for other
platforms), tokens, the device secret and pinned ids stay in web storage, and
the token field says so. Don't use such builds where that matters.

**What that protects against, and what it doesn't:**

- **Another user account on the same Mac** (not an administrator) can't read
  any of it, because `~/Library` is readable by its owner only. It also can't
  stop the app from starting, because the single-instance lock is in the
  user's own data folder. It can't talk to the running app either, because
  the app checks the other end's user id. An administrator can read the user's
  files and, while the app runs, its memory. The user's login password still
  encrypts the login keychain file.
- **Another process running as the same user** (malware, a rogue app) gets
  past all of this. These protections slow it down but do *not* stop it. It
  can read web storage (name, invite codes). It can read the clipboard when a
  token is pasted. It can watch or script the UI if the user granted it
  Accessibility access. It can make the app lose its identity (for example by
  editing web storage), which is a denial of service, not a takeover. With an
  unsigned or ad-hoc-signed build, it can get its own code into the app and
  read whatever the app can. It can't read the Keychain items quietly,
  because their access list makes macOS ask the user first. That makes an
  attack harder, but it is not a boundary against malware running as the
  user. A Developer ID signature with the hardened runtime (section 3) also
  makes macOS refuse to let other processes attach to or inject code into the
  app.
- **A stolen laptop, locked or off.** With FileVault on, nothing is readable
  without the user's password, and the login password also encrypts the login
  keychain. Without FileVault, someone can read web storage (name, invite
  codes) from the disk. They can't read the Keychain items without the login
  password. Make FileVault mandatory through MDM.
- **A stolen laptop that is unlocked, or a login password the thief knows.**
  Assume everything is readable, tokens and device secret included. **Revoke
  the token** by deleting the person's line in the tokens file. The hub then
  refuses that laptop whatever it holds. See
  [A stolen laptop or a departed employee](#a-stolen-laptop-or-a-departed-employee).
- **Script running in the webview.** If a bug ever let a hub inject script,
  that script can read the token for a hub and ask for this device's id for a
  hub, because the app itself needs both. It can't get the device secret, so
  it can't derive ids later, elsewhere. In a locked build it can do either
  only for your hub, because the native commands refuse any other. The CSP
  lets it open connections (WebSockets, `fetch`) only to your hub, and load
  scripts, styles, images and frames only from the app itself. The CSP alone
  would not stop it from navigating its own window to another site and taking
  what it read along in the address. So the app refuses every navigation
  except to its own pages (`own_page` in `src-tauri/src/lib.rs`, and a dev
  build also allows the Vite dev server). In the pack's window the script
  can't save a token at all. It can show, hide, move or resize the pack's
  window, but not the settings window. It could replace this device's pinned
  id for your hub, because the once-only move from older versions needs that
  command. That loses the person's place but tells the script nothing it
  couldn't already read.

#### Limits

The access token is a password-like secret. Whoever has it (and the invite
code) can connect as that person. The login Keychain protects it from other
accounts on the Mac, and from someone who has the disk of a locked or switched
off laptop. Against malware running as the same user, it only slows things
down with a prompt, which a user may click through. There is no single
sign-on. The app doesn't know your directory, and leaving the company doesn't
log anyone out by itself. When a laptop is lost unlocked (or someone leaves),
delete that person's line in the hub's tokens file. That is what cuts the
laptop off.

Trade-offs and checks:

- The item's access list names the app's code signature. A signed release
  keeps the same identity across updates, so updates don't prompt. Unsigned or
  ad-hoc-signed dev builds change identity with every build, so macOS asks
  "Smoke Break wants to use your confidential information" after a rebuild.
  Click Always Allow, or sign dev builds with a fixed identity.
- The app uses the classic file-based login keychain. The newer
  data-protection keychain would tie the items to the app's signing team. But
  macOS lets only apps with a keychain-access-group entitlement use it, which
  means a signed app with a provisioning profile, and the app has to work
  unsigned too.
- On some installs, an older version wrote the items to a *different* default
  keychain. That happens only if someone had changed the default. Such an
  install won't find the items in the login keychain. The person enters their
  token again and gets a new device secret, so a team they owned needs
  `server/admin.ts set-owner`.
- `cd src-tauri && cargo test` checks the derivation against the cases in
  `shared/client-id-vectors.json` (the TypeScript tests check the same ones).
  It also checks the single-instance lock, and which window may call which
  command, using the real capability files on Tauri's mock runtime. It also
  checks the hub lock. To check a locked build, run it with
  `VITE_LOCK_SERVER=1 VITE_SERVER_URL=wss://…`. Unit tests never open the
  login keychain. `cargo test -- --ignored temp_keychain_round_trip` tests the
  Keychain code against a throwaway keychain file that it creates and deletes.
  macOS adds that file to the keychain list while the test runs.

### How the CSP pin works

`tauri.conf.json` lets the webviews open WebSockets to any `wss:` host (plus
localhost for development), because in a general build the Server field can
point anywhere. A locked build doesn't need that. So `desktop:build:enterprise`
pins `connect-src` to your hub, and even injected script can't open a
connection to another server or send its window to another site (see
"Script running in the webview" under
[What is stored where on the Mac](#what-is-stored-where-on-the-mac)). Tauri
merges the override into `tauri.conf.json` with JSON Merge Patch, which
replaces only the keys given. Here it replaces each CSP as a whole with its
pinned policy string. Tauri then compiles the CSP into the app's executable.
Only `tauri dev` uses `devCsp`, but the script pins it too, so the wide list
isn't in the binary at all.

The script checks the result itself. Every `connect-src` in the executable
must end at its `;` and allow exactly the app and your hub, in any order, and
nothing more. A `connect-src` whose end the script can't find fails the check.
That is Tauri's form for a CSP given as directives instead of one string,
which the default build uses. The default's source list anywhere in the
executable also fails it.

To look by hand, run the command below. You set `$APP` in step 3. The command
should print one line, with a count and
`connect-src 'self' ipc: wss://breaks.acme.internal;`. The count is one per
CSP (`csp` and `devCsp`) in each architecture of the binary.

```sh
grep -a -o -i "connect-src[^;]*;" "$APP"/Contents/MacOS/* | sort | uniq -c
```

If you build the app with `cargo` and without the Tauri CLI, put the same
override (the file `desktop:build:enterprise` writes) in the `TAURI_CONFIG`
environment variable. Set the same build settings for both the frontend and
`cargo`, because the build record, the native hub lock and the meeting host
pin come from them:

```sh
export VITE_SERVER_URL=wss://breaks.acme.internal/ws VITE_LOCK_SERVER=1 SMOKE_BREAK_MEETING_HOST=acme.zoom.us
npm run build    # the frontend in dist/, which cargo embeds
cd src-tauri && TAURI_CONFIG="$(cat target/enterprise-build/tauri.override.json)" cargo build --release --features tauri/custom-protocol
```

Don't leave out `--features tauri/custom-protocol`. The Tauri CLI adds it for
you. Without it, cargo makes a development build whose windows load from
`http://localhost:5173` instead of the pages inside the app. Then whatever is
listening on that port on the Mac would run as the app.

That gives a bare executable (`target/release/smoke-break`), not a bundle.
`--check` needs the executable inside an `.app` (`Contents/MacOS/`), which
`tauri build` makes.

### A stolen laptop or a departed employee

Smoke Break has no accounts. A person's access token (with per-user tokens)
and the device secret on their Mac prove who they are. When a laptop is
stolen or someone leaves, do this:

1. **Delete their line from the tokens file.** The hub picks up the change
   within seconds, drops their open connections and refuses new ones. The
   laptop (or the person) can't reach the hub any more, whatever is stored on
   it. You need no restart and no new build, and nobody else is affected.
2. **If they owned a team,** nobody can change that team's settings until it
   has an owner again. The hub admin reassigns it on the hub machine with
   `node server/admin.ts set-owner <team-ref> <member-id>`. `list` shows both
   values. Stop the hub first, as the script says. The new owner can then
   remove the old account from the roster. That removes all of that person's
   devices and replaces the invite code, which they knew.
3. The admin script also has `unban`, to let back in someone who was removed
   by mistake, and `codes`, to look up a team's current invite code.
4. If the person comes back, give them a new token line, and they enter the
   token in the app.

## 3. Sign and notarize

On a Mac with Xcode command line tools, run this in the repo root:

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

With those variables set, `tauri build` (which the script runs) signs the app
with the hardened runtime, submits it to Apple's notary service, waits, and
staples the ticket. The script then checks the built app with the same checks
as `--check` (below) and prints a summary. The build writes
`src-tauri/target/universal-apple-darwin/release/bundle/macos/Smoke Break.app`
and `…/bundle/dmg/Smoke Break_<version>_universal.dmg`.

### Checking a built app

This is the last step before handing the app to MDM. Repeat it on exactly the
copy you hand over. It builds nothing and changes nothing.

```sh
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Smoke Break.app"
VITE_SERVER_URL="wss://breaks.acme.internal/ws" SMOKE_BREAK_MEETING_HOST="acme.zoom.us" \
  npm run desktop:build:enterprise -- --check "$APP"
```

It prints a table and exits non-zero if any line says FAIL:

| Check | Passes when |
|---|---|
| Build record | the executable carries the record that `src-tauri/build.rs` writes at build time (hub, server lock, whether a shared token was set, meeting host, but never the token itself) |
| Hub address | it is a `wss://` hub, and the one in `VITE_SERVER_URL` if you set it |
| Server lock | the app was built with `VITE_LOCK_SERVER=1`, and the hub lock the native commands obey is on and names the same hub as the record. That lock is the marker `sb-lock:v1:on:<hub> :end`, which `src-tauri/src/lock.rs` reads at run time. An app built from older sources has no marker and fails. |
| Shared access token | `VITE_HUB_TOKEN` was empty |
| Meeting host pinned | a Zoom host is pinned, is in the code that checks links (not only in the record), and matches `SMOKE_BREAK_MEETING_HOST` if set |
| CSP connect-src | there is a `connect-src` in the executable, and every one is a complete directive (ended by `;`) whose sources are exactly `'self' ipc: <your hub origin>` in any order, comparing the hub as a whole. Nothing of the wide default is left. When the record has no usable hub, the check uses `VITE_SERVER_URL`. |
| Signed | the app is signed with a real identity, not unsigned or ad-hoc. `--allow-unsigned` turns this into a warning, for test builds only. |
| `codesign --verify --deep --strict` | the signature is valid for everything in the bundle |
| Hardened runtime | the code directory flags include `runtime` |
| Notarization | if the app is notarized (it has a stapled ticket, or `spctl` says so), `spctl --assess` accepts it. If the app is not notarized, the check warns. On a Mac with Gatekeeper turned off, `spctl` accepts anything, so this check fails there. Run the check on a Mac with Gatekeeper on. |

The record holds what the build was configured with. The frontend itself is
compressed inside the executable, so `--check` can't read the hub address out
of it. The enterprise build checks that in `dist/` right after building.

## 4. Distribute with MDM

- Run `--check` on the app first ([Checking a built app](#checking-a-built-app)).
- Wrap the app in a signed **.pkg**, since most MDMs want one:
  ```sh
  productbuild --component "$APP" /Applications \
    --sign "Developer ID Installer: Acme Inc (TEAMID1234)" SmokeBreak-<version>.pkg
  xcrun notarytool submit SmokeBreak-<version>.pkg --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
  xcrun stapler staple SmokeBreak-<version>.pkg
  ```
  (The installer certificate is a second certificate type, "Developer ID
  Installer", from the same account.)
- Upload the pkg to your MDM (for example Jamf, Kandji, Intune or Mosyle) and
  scope it.
- "Launch at login" uses a LaunchAgent. On macOS 13 and later, users get a
  "Background item added" notice. To pre-approve it, push a Service Management
  **Managed Login Items** payload (`com.apple.servicemanagement`) with a rule
  for Team ID `TEAMID1234` (or for the bundle identifier).
- The app needs no privacy (TCC or PPPC) permissions. It reads the cursor
  position through the window system, which needs no Accessibility grant.

## 5. Shipping updates

The app has no built-in updater. For a managed fleet, the simplest path is:

1. Bump `version` in `tauri.conf.json` (and `package.json`, `Cargo.toml`).
2. Build, sign, notarize and package as above.
3. Upload the new pkg to the MDM as a new version of the same title, and let
   the MDM's patch policy install it. It replaces
   `/Applications/Smoke Break.app`. Security fixes then reach every machine on
   the MDM's next check-in, with no action from users.

If you ever ship outside MDM, add `tauri-plugin-updater`. Generate an updater
key pair (`npx tauri signer generate`), put the public key in
`plugins.updater.pubkey`, serve `latest.json` over https, and build with
`TAURI_SIGNING_PRIVATE_KEY` set. Updater signatures are separate from Apple
code signing, and you need them in addition to it.

## Before you deploy

- [ ] You built the app with `npm run desktop:build:enterprise`, and the build
      ended with the "Enterprise build done. Pinned:" summary naming your hub
      (`wss://…`), your Zoom host and your signing identity.
- [ ] Access uses per-user tokens in `SMOKE_BREAK_ACCESS_TOKENS_FILE`, one
      line per person, handed out privately. There is no shared
      `VITE_HUB_TOKEN`, and no shared token on the hub either.
- [ ] You know what to do when a laptop is lost or someone leaves. Delete
      their line, and reassign their teams with `server/admin.ts set-owner`.
- [ ] You signed the app with your Developer ID, notarized and stapled it, and
      `npm run desktop:build:enterprise -- --check "$APP"` passes on the copy
      you hand to the MDM.
- [ ] You packaged it as a signed, notarized `.pkg` and uploaded it to the
      MDM, with the Managed Login Items payload if you want "Launch at login"
      pre-approved.
- [ ] You know how the next version gets out. Bump the version, build, sign,
      notarize, upload to the MDM as a new version of the same title, and let
      its patch policy install it (section 5). Keep the bundle identifier and
      signing identity the same. Otherwise people onboard again and the
      Keychain asks about their saved token.
