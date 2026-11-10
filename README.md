# Smoke Break

A little pixel-art pack that floats on your desktop and gets your team on a break together.

Click the pack to invite your team. When a second person joins, a lighter appears; light up and everyone's Zoom call opens. The cigarette then burns down as the break timer (10–15 minutes).

Not a smoker? Pick another **break style**:

- **Water:** a water cooler whose jug drains as the timer, with a cup to fill instead of a lighter.
- **Coffee:** a coffee maker that pours everyone a mug; the pot drains as the timer.
- **Donut:** a bakery box of donuts. Yours gets sprinkles, then gets eaten bite by bite as the timer.

Styles and skins are personal, so teammates can share the same break and each see their own.

[![Smoke Break in action (36-second video)](brag-output/brag.jpg)](brag-output/brag.mp4)

> **Status:** a working prototype. The desktop app has only been built and tested on macOS so far; Windows and Linux are tracked in [#1](https://github.com/DementedEarplug/smoke-break/issues/1).

## How it works

There are two pieces:

- **The app**: the floating pack on each person's screen. It's a desktop overlay (built with [Tauri](https://tauri.app)) that sits on top of other windows; clicks on the empty space around it pass straight through. There's also a browser version of the same pack for testing.
- **The hub**: a small server that everyone on the team connects to. It keeps track of teams and runs the break timer, so everyone sees the same break at the same time.

For local development, one command starts both. For a real team, someone runs the hub on a server everyone can reach, behind HTTPS (see [Running a shared hub](#running-a-shared-hub)).

## Requirements

- [Node.js](https://nodejs.org) 22.18 or newer (the hub runs TypeScript directly).
- For the desktop app: Rust and Tauri's system dependencies. See [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/) (on macOS: Xcode Command Line Tools and `rustup`).

## Quick start

### Desktop app

```sh
npm install
npm run desktop
```

This starts the hub and opens the app. On first launch the **Settings** window opens: enter your name, then start a team or join one with an invite code. After that the pack floats in the bottom-right corner of your screen.

The app lives in the menu bar (there's no Dock icon). The menu-bar icon has **Settings…**, **Do not disturb**, **Launch at login**, and **Quit**.

### Browser version

```sh
npm install
npm run dev
```

Open http://localhost:5173 and start a team. To try a break on your own, click **Open a teammate tab**: each tab acts as a separate person.

### Demo mode

`npm run demo` (browser) and `npm run desktop:demo` (desktop) make a break "minute" last 3 seconds, so a 12-minute break takes 36 seconds.

## Setting up your team

1. **Start a team.** Whoever starts it becomes the team's **owner**, the only person who can change team settings, let people in and remove them.
2. **Add the Zoom link.** The owner opens **Settings** in the team panel and pastes the team's Zoom meeting link. It must be an `https://` link on `zoom.us`, `zoom.com` or `zoomgov.com`, because the machines of everyone in a break open it automatically.
3. **Invite people.** Share the invite code (desktop) or invite link (browser) from the team panel. Teammates enter it when they first open the app.
4. **Let them in.** By default a new person with the right code doesn't join straight away: the owner sees them under **waiting** in the team panel and lets them in (or turns them away). On a hub with per-person tokens the owner also sees whose token each person (waiting or on the team) connected with, which, unlike the name, nobody can choose. Their app keeps asking until then. Someone turned away can't ask that team again for a day. The owner can switch approval off in Settings, so that the code alone is enough, except on a hub in strict mode (`SMOKE_BREAK_ENTERPRISE=1`), where approval is always on.
5. **Pick a default length** in Settings (10–15 minutes). Whoever starts a break can still change it before anyone joins.

The team panel lists everyone on the team, online or not; names stay reserved for their owners while they're offline. The owner can **remove** anyone on that list, **change the invite code**, and **hand the team over** to another member. With per-person tokens, removing someone removes every device they joined with under their token, not just the one picked; removing one of the owner's own devices (one that joined with the owner's token) removes just that device.

Everyone must connect to the same hub. On a single computer that happens automatically; for a team spread across machines, see [Running a shared hub](#running-a-shared-hub).

## Using the pack

- **Click the pack** to start a break, or to join one someone else started.
- **Scroll on the pack** (or use the − / + buttons) to change the length before anyone joins.
- **Click the lighter** to light up. Your cigarette comes out of the pack, catches in the flame and lands beside the pack, then Zoom opens.
- **Click your own cigarette** to put it back (before lighting) or stub out early.
- **Drag** the pack to move it. **Right-click** it to turn do-not-disturb on or off.
- **Pinch** (or ⌃-scroll) on the pack to resize it.

In the **My pack** panel (in the Settings window on desktop, beside the team panel in the browser) you can change the size, the pack and lighter skins, and the **Break style** (Smoke, Water, Coffee or Donut). These settings stay on your device and never change what teammates see.

## Running a shared hub

For people on different machines, run the hub where everyone can reach it.

> **The dev and preview servers are not a hub deployment.** `npm run dev` and `npm run share` run a hub inside Vite for development and quick tests on a trusted network. They speak plain HTTP and serve the project's files. Don't expose them to the internet or put a tunnel in front of them for real use.

**For a quick test on your own network**, `npm run share` serves the browser version and a hub. Set `SMOKE_BREAK_PUBLIC_HOST` to the address teammates will open (for example `SMOKE_BREAK_PUBLIC_HOST=192.168.1.20 npm run share`); otherwise only pages opened on `localhost` can connect.

### Enterprise deployment checklist

For a company rollout, every item here is needed; none is an optional extra. The steps below explain each one, and [src-tauri/SIGNING.md](src-tauri/SIGNING.md) covers the app side.

- [ ] **`SMOKE_BREAK_ENTERPRISE=1`** (strict mode), so the hub itself enforces the hub settings in the next three items (it can't see the TLS proxy, only what it's told about it): it refuses to start (exit status 78, listing everything missing) without a per-person tokens file, `SMOKE_BREAK_PUBLIC_HOST`, and either `SMOKE_BREAK_PROXY_SECRET` or `SMOKE_BREAK_SOCKET`; it also refuses a `HOST` other than a loopback address unless the proxy secret is set; and it keeps owner approval on for every team (an owner can't switch it off, and teams saved with it off get it back on at startup).
- [ ] **The hub behind a TLS reverse proxy** (`wss://` only), with either `SMOKE_BREAK_PROXY_SECRET` (and `SMOKE_BREAK_TRUST_PROXY` set to the proxy) or `SMOKE_BREAK_SOCKET`, so nothing can connect around the proxy ([step 2](#setting-up-the-hub)).
- [ ] **A per-person tokens file** in `SMOKE_BREAK_ACCESS_TOKENS_FILE`: mode `0600`, owned by the hub's user, **one line per person** (a label is one person; never share a line), edited only by writing a new file and renaming it over the old one ([step 1](#setting-up-the-hub)). No `SMOKE_BREAK_ACCESS_TOKEN`.
- [ ] **`SMOKE_BREAK_PUBLIC_HOST`** set to the hub's name.
- [ ] **A dedicated user and the systemd unit** below ([step 3](#setting-up-the-hub)), with a `0700` data directory and a `0600` env file. The unit doesn't restart the hub when it exits with status 78 (something only an admin can fix), and gives up after 5 failed starts in 5 minutes.
- [ ] **The app built with `npm run desktop:build:enterprise`** (`VITE_SERVER_URL=wss://…` and `SMOKE_BREAK_MEETING_HOST` required; it locks the app to your hub, pins its content security policy to it and checks the built app), then signed, notarized and rolled out as in [SIGNING.md](src-tauri/SIGNING.md#2-build-time-settings-for-your-company). Not `npm run desktop:build`, and no `VITE_HUB_TOKEN`.
- [ ] **When someone leaves:** delete their line from the tokens file (they're cut off within seconds). If they owned a team, the audit log says so (`owner-token-revoked`): stop the hub, `admin.ts list` and `admin.ts set-owner <team-ref> <member-id>`, start it again. See also [A stolen laptop or a departed employee](src-tauri/SIGNING.md#a-stolen-laptop-or-a-departed-employee).
- [ ] **Collect the audit log, and alert on it.** It's one JSON line per event on the hub's stdout (under systemd: `journalctl -u smoke-break`); warnings and errors (startup problems, a broken tokens file, a dropped team) go to stderr. Alert at least on `limit`, `transfer-owner`, `owner-token-revoked` and `audit-dropped` (see [Limits of this design](#limits-of-this-design)). The events:

| Event | Means |
| --- | --- |
| `load` | The hub started and read its team file (counts of teams, invalid and expired entries; `enterprise` for strict mode, and `approvalSwitchedOn`, the teams it turned approval back on for). |
| `create`, `join`, `join-requested`, `join-failed` | A team was made (with the label's totals: `labelTeams`, the teams counted against its limit; `labelOwns`; `labelCreated`, teams it made that still exist; `labelCreatesToday`), someone joined, asked to join, or was refused (with the reason). |
| `rename` | Someone on a team's roster connected under a new name (`from`, `to`). A few a minute per person are written; the rest are counted in `suppressed`. |
| `approve-member`, `deny-member` | The owner let someone in, or turned them away for a day. |
| `remove-member` | The owner removed someone (and every other device under their label: `alsoRemoved`; `ownDevice` when it was one of the owner's own). |
| `transfer-owner`, `rotate-code`, `settings` | The owner handed the team over (with the new owner's label `toLabel`, who made the team `createdBy`, and both labels' counts after it: `labelOwns`, `labelCreated`, `toLabelOwns`, `toLabelCreated`), replaced the invite code, or changed settings. |
| `tokens-reloaded`, `tokens-file-broken` | The tokens file was read again (with the labels it revoked), or can't be used (no token is valid until it's fixed). |
| `token-revoked` | Connections of a revoked label (or of everyone, while the file is broken) were closed. |
| `owner-token-revoked`, `ownerless-team` | A team has an owner whose token is gone, or no owner at all: an admin should `set-owner`. |
| `team-forgotten` | A team was forgotten while the hub ran: idle for 90 days, or junk that made room for a new team. (Teams already idle that long at startup are counted in `load` as `expired`.) |
| `limit` | A limit was hit (`kind` says which: `unauthorized`, `origin`, `proxy-secret`, `bad-codes`, `join-leave`, `set-length`, `presence`, `rename`, `settings`, `teams-per-label`…). |
| `suppressed`, `audit-dropped`, `audit-queued` | Lines held back by the log's own limits, counted (see [below](#audit-log)). |

### Setting up the hub

Run the standalone hub behind a TLS reverse proxy, so apps connect over `wss://`:

```sh
SMOKE_BREAK_ENTERPRISE=1 \
SMOKE_BREAK_ACCESS_TOKENS_FILE=/etc/smoke-break/tokens \
SMOKE_BREAK_PUBLIC_HOST=breaks.example.com \
SMOKE_BREAK_TRUST_PROXY=127.0.0.1 \
SMOKE_BREAK_PROXY_SECRET=… \
SMOKE_BREAK_DATA_DIR=/var/lib/smoke-break \
npm run server            # listens on 127.0.0.1:8787 (set HOST and PORT to change it)
```

1. **Give each person a token.** `SMOKE_BREAK_ACCESS_TOKENS_FILE` names a file with one `label:token` line per person, and lines starting with `#` are comments:

   ```text
   # label:token, one per line. Labels show up in the audit log; tokens never do.
   # Make each token with: openssl rand -hex 32
   alice:4f9c2e0b…
   bob:9a01d7c3…
   ```

   Labels are 1 to 64 letters, digits and `. _ @ + -` (starting with a letter or digit); tokens are 16 to 512 printable characters without spaces. The file may have at most 50,000 lines. The hub looks a presented token up by its SHA-256 digest, so checking one costs the same however many people are in the file.

   **A label is one person.** The hub ties devices, bans, quotas and removal to it: removing one device under someone's label removes every device under it and bans the label from that team (an owner removing one of their own devices removes just that one), and a line several people share can only be revoked for all of them at once. Don't give a line to a group.

   The file must be readable only by the hub's user (`chmod 600`), or the hub refuses to start; it also refuses a malformed or oversized file, naming the line (never the token).

   **The hub re-reads the file within about two seconds of any change; no restart is needed.** Delete a line to revoke that token: the hub closes that person's connections, drops their waiting join requests, and from then on nothing they joined with can be used again, whatever token or device they try (each device they joined with only works with their own token). If a revoked person owned a team, the audit log says so (`owner-token-revoked`, with the team's ref) so you can hand the team over with `admin.ts set-owner`.

   **Edit it by writing a complete new file and renaming it over the old one** (e.g. `install -m 600 -o smoke-break tokens.new /etc/smoke-break/tokens.tmp && mv /etc/smoke-break/tokens.tmp /etc/smoke-break/tokens`), not by editing it in place: if the hub ever reads a file that is unreadable, malformed or has the wrong mode, it fails closed. Until the file is fixed **no token is valid**: new connections are refused, and everyone connected with a per-person token is disconnected (their apps keep their team and retry). The log says so once, with the reason.

   Alternatively, `SMOKE_BREAK_ACCESS_TOKEN` sets a single token shared by everyone. Use one or the other: the hub refuses to start with both set, since a shared token would let anyone back in past every per-person revocation and ban. **The shared token is the weaker mode by design:** it can't be revoked for one person, there are no per-person limits (team creation, wrong codes, join requests and messages are limited per address and across the hub), and anyone holding it can use up the hub-wide allowance for new teams and so block team creation for everyone. Strict mode (`SMOKE_BREAK_ENTERPRISE=1`) refuses to start with a shared token or none. Without strict mode, the hub prints one warning line at startup for each recommended protection it runs without: a shared token, no token at all, no `SMOKE_BREAK_PUBLIC_HOST`, and `SMOKE_BREAK_TRUST_PROXY` without `SMOKE_BREAK_PROXY_SECRET` or `SMOKE_BREAK_SOCKET`. Per-person tokens can be revoked one at a time, the audit log says who did what, the owner sees whose token each person used, removing a person removes them (all their devices, and their token for that team), and the limits are per person instead of per address.

   The app sends its token when it connects (as a WebSocket subprotocol), and the hub checks it before accepting the connection at all: without a valid token there's no connection (HTTP 401), so strangers can't hold connections open.
2. **Put TLS in front of it.** Any reverse proxy that handles WebSockets works (Caddy, nginx, a cloud load balancer). It should terminate HTTPS for `breaks.example.com`, forward `/ws` to the hub, pass the `Host` header through, and set `X-Forwarded-For` to the client's address. List the proxy's address in `SMOKE_BREAK_TRUST_PROXY` (IPs or CIDR ranges, comma-separated; `1` means "loopback only"): the hub believes `X-Forwarded-For` only from those addresses, and takes the right-most entry that isn't one of them. With two proxies in a row (say a CDN and nginx), list both. The hub listens on `127.0.0.1` by default, so nothing reaches it from other machines except through the proxy; set `HOST` only if the proxy runs elsewhere. Better still, keep the hub on your VPN or behind your SSO proxy as well.

   **If anyone else can log in to the hub's machine, use one of these two**, because any local process can connect to `127.0.0.1` too, skipping the proxy and writing its own `X-Forwarded-For` (to pose as other addresses, or to get a colleague's address locked out):

   - **A proxy secret.** Set `SMOKE_BREAK_PROXY_SECRET` to a long random value (`openssl rand -hex 32`) and have the proxy send it in an `X-Smoke-Break-Proxy` header. The hub refuses every connection without it, and only believes `X-Forwarded-For` along with it. Keep the secret where other users can't read it: the hub's env file (`0600`), and a proxy config file only root can read.
   - **A Unix socket.** Set `SMOKE_BREAK_SOCKET=/run/smoke-break/hub.sock` and the hub listens there instead of on TCP (`HOST`, `PORT` and `SMOKE_BREAK_TRUST_PROXY` don't apply). The socket is created `0660`, so only the hub's user and group can connect: put the proxy's user in the hub's group, and nobody else. A socket file left behind by a crash is removed at startup; anything else at that path stops the hub from starting.

   Caddy:

   ```caddyfile
   breaks.example.com {
       reverse_proxy /ws 127.0.0.1:8787 {
           # Caddy sets X-Forwarded-For to the client's address itself.
           header_up X-Smoke-Break-Proxy {env.SMOKE_BREAK_PROXY_SECRET}
       }
       # Or, with SMOKE_BREAK_SOCKET instead of a secret:
       # reverse_proxy /ws unix//run/smoke-break/hub.sock
   }
   ```

   nginx:

   ```nginx
   location = /ws {
       proxy_pass http://127.0.0.1:8787;
       # Or, with SMOKE_BREAK_SOCKET instead of a secret:
       # proxy_pass http://unix:/run/smoke-break/hub.sock:/ws;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $remote_addr;   # replace, don't append to what the client sent
       # A file only root can read (chmod 600), holding:  proxy_set_header X-Smoke-Break-Proxy "<secret>";
       include /etc/nginx/smoke-break-secret.conf;
   }
   ```
3. **Run it under a supervisor** that restarts it, so it comes back after a crash or reboot. It saves pending changes and closes connections cleanly on `SIGTERM` and `SIGINT`. If it can't start it exits with an error: **status 78** when only an admin can fix it (a team file that can't be read or isn't a valid team list, a data directory other users can write to, a bad tokens file, an invalid setting, something strict mode requires, a file in the way of `SMOKE_BREAK_SOCKET`, not being allowed to listen), and status 1 for what may pass by itself (the port or socket is still in use, say by a hub shutting down). Restarting on 78 changes nothing, so the unit below doesn't, and it stops trying after 5 failed starts in 5 minutes. A systemd unit, with a dedicated user:

   ```ini
   # /etc/systemd/system/smoke-break.service
   # One-time setup:
   #   useradd --system --home /var/lib/smoke-break --shell /usr/sbin/nologin smoke-break
   #   install -d -o smoke-break -g smoke-break -m 0700 /var/lib/smoke-break
   #   install -o root -g root -m 0600 /dev/null /etc/smoke-break/env   # then add the variables below
   #   install -o smoke-break -g smoke-break -m 0600 /dev/null /etc/smoke-break/tokens
   [Unit]
   Description=Smoke Break hub
   After=network-online.target
   # Give up after 5 failed starts in 5 minutes instead of retrying forever.
   StartLimitIntervalSec=300
   StartLimitBurst=5

   [Service]
   User=smoke-break
   Group=smoke-break
   WorkingDirectory=/opt/smoke-break
   # SMOKE_BREAK_ENTERPRISE=1, SMOKE_BREAK_DATA_DIR=/var/lib/smoke-break,
   # SMOKE_BREAK_ACCESS_TOKENS_FILE=/etc/smoke-break/tokens, SMOKE_BREAK_PUBLIC_HOST=…, and either
   # SMOKE_BREAK_TRUST_PROXY=… with SMOKE_BREAK_PROXY_SECRET=…,
   # or SMOKE_BREAK_SOCKET=/run/smoke-break/hub.sock (with the RuntimeDirectory lines below)
   EnvironmentFile=/etc/smoke-break/env
   # For SMOKE_BREAK_SOCKET: a directory the proxy's user can reach through the group.
   # RuntimeDirectory=smoke-break
   # RuntimeDirectoryMode=0750
   ExecStart=/usr/bin/node server/main.ts
   Restart=always
   RestartSec=2
   # 78: a bad team file, tokens file or setting. Restarting won't fix it; the journal says what will.
   RestartPreventExitStatus=78
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   ReadWritePaths=/var/lib/smoke-break

   [Install]
   WantedBy=multi-user.target
   ```

   The data directory must not be writable by other users (the hub refuses to start otherwise), and the env file, which may hold `SMOKE_BREAK_ACCESS_TOKEN` or `SMOKE_BREAK_PROXY_SECRET`, should be `0600`.
4. **Build the app for your hub.**

   **For a company rollout, use the enterprise build**, and follow [src-tauri/SIGNING.md](src-tauri/SIGNING.md) for its settings, signing, notarization and MDM rollout:

   ```sh
   VITE_SERVER_URL=wss://breaks.example.com/ws \
   SMOKE_BREAK_MEETING_HOST=example.zoom.us \
   APPLE_SIGNING_IDENTITY="Developer ID Application: Example Inc (TEAMID1234)" \
   npm run desktop:build:enterprise
   ```

   It refuses to build without a `wss://` `VITE_SERVER_URL` and a Zoom `SMOKE_BREAK_MEETING_HOST`, and refuses `VITE_HUB_TOKEN`. It locks the app to your hub (`VITE_LOCK_SERVER=1`: no **Server** field, and nobody can point it at another hub), makes it open meeting links only on your Zoom host, pins the app's content security policy to your hub alone, and checks the built app before it finishes; if a check fails, don't ship that build. Each person enters their own token in the app.

   **Just trying it out?** `npm run desktop:build` builds an app you point at a hub with the **Server** field during onboarding (or with `VITE_SERVER_URL` at build time; without one it connects to `ws://localhost:8787/ws`). Its content security policy allows `wss:` connections to any host, so don't roll it out to a company.

   Both put `Smoke Break.app` and a `.dmg` in `src-tauri/target/release/bundle`. The app only accepts `wss://` addresses, apart from `localhost`. Apps from before this version don't send their token when connecting, so a hub that requires tokens refuses them: update the apps along with the hub.

Teams are saved to `$SMOKE_BREAK_DATA_DIR/teams.json` (default: `.data/teams.json` in the repo), readable only by the user running the hub. The file holds every invite code and Zoom link, so keep it out of anything a web server serves and out of backups other people can read. Saves are atomic (a fresh, randomly named temp file that never follows a symlink). If the file exists but can't be read (wrong owner or permissions), isn't a valid team list, or has entries none of which is a valid team, **the hub refuses to start** (exit status 78) and says why, naming the file and, for a corrupt one, the `teams.json.corrupt-<timestamp>` copy it kept: starting with no teams would make every app forget its team. Fix or restore the file, or move it away to really start with no teams. If only some entries are invalid, the hub starts without them, but first keeps the file as it was in `teams.json.partial-<timestamp>` and names each dropped entry on stderr (by its team ref, or its position if it has none). These copies (and `teams.json.pre-roster-<timestamp>`, below) are `0600`. No copy is written when one with the same size and SHA-256 is already there (the hub names that one instead), so starting over and over on the same bad file doesn't fill the disk; and only the 5 newest copies of each kind are kept, older ones of that kind are deleted. Breaks in progress live in memory, so restarting the hub ends them.

**Upgrading from an older hub.** On first start the hub converts the file to the current format and keeps the old one as `teams.json.pre-roster-<timestamp>`. Everyone the old hub remembered becomes a roster member (shown without a name until they reconnect); owners and removals are kept; approval is switched on for every team. Teams with an old 6-character code get a new 10-character one. People on the roster get straight back in with the old code and then receive the new one. Teammates the old hub didn't remember (hubs from before member lists only remember each team's owner) aren't told the code is wrong: their app's attempt with the old 6-character code becomes a join request that the owner sees under **waiting** and approves, as long as approval stays on and until the owner replaces the invite code (by hand, or by removing someone). After that, the old code is wrong for anyone not on the roster, and their app forgets the team; the owner shares the current code instead. Teams from before owners existed have nobody to approve anyone, so nobody gets in (their apps keep the team and wait) until you make someone the owner with `admin.ts set-owner`; the audit log names each such team once (`ownerless-team`), and `admin.ts list` shows who has asked to join it.

**Admin tasks.** `server/admin.ts` works on the team file. Run it **as the hub's user** (e.g. `sudo -u smoke-break …`, with the same `SMOKE_BREAK_DATA_DIR`): it refuses to run as anyone else, so it can't leave the file owned by root or another user, and it keeps the file's mode. For the commands that change the file, **stop the hub first** and start it again afterwards; a running hub would overwrite the change.

```sh
sudo -u smoke-break node server/admin.ts list                       # teams (by ref), members' ids, labels, who's waiting; no codes or links
sudo -u smoke-break node server/admin.ts codes <team-ref>           # print that team's current invite code
sudo -u smoke-break node server/admin.ts set-owner <team-ref> <id>  # hand the team to someone on its roster (or waiting to join it)   [hub stopped]
sudo -u smoke-break node server/admin.ts unban <team-ref> <id|label># lift a removal or a denial, for one identity or a whole label  [hub stopped]
sudo -u smoke-break node server/admin.ts delete-team <team-ref> --yes  # delete a team; its members' apps forget it            [hub stopped]
```

(It uses `SMOKE_BREAK_DATA_DIR` like the hub, or `--file path/to/teams.json`.) Use `set-owner` when an owner has left or their token was revoked, and for teams from before owners existed. Removals last until you `unban`; someone turned away can ask again after a day without your help. `delete-team` without `--yes` only says what it would delete; `list` shows each team's owner label, when it was last used and whether it ever had a group break, to spot junk.

#### Audit log

The hub writes one JSON line to stdout for each event in the [table above](#enterprise-deployment-checklist), with a timestamp, the client's address and, with per-person tokens, the token's label. These lines never contain invite codes, access tokens, client IDs or meeting links. So that nobody can crowd out the lines that matter, lines come out of separate budgets:

- **Refused upgrades** (no or wrong token, wrong origin or host, missing proxy secret), which anyone who can reach the hub can cause, share one small budget across the hub (a burst of 10, then 2 a second); the rest are counted by kind in an `audit-dropped` line once a minute.
- **Other lines from connections without a token label** (shared token or open hub): up to 50 a second.
- **Lines from people with a token label, and owners' settings changes**: up to 20 a second, which nothing else can use.
- **Security events** (removals, approvals and denials, ownership changes, code changes, revoked tokens, token reloads, forgotten teams, ownerless teams, the startup `load` line) are never dropped for being over budget (20 a second): they wait in a queue and are written in order. Only if 10,000 are waiting are more lost, and the hub says so (`audit-dropped` with `"class":"critical"`, and on stderr).

Lines a client can cause over and over (failed joins, limit hits, name changes) are also limited per reason and address (or label), a few a minute, with a periodic `suppressed` line counting the rest. Collect the lines with your usual log tooling.

### Hub settings

| Environment variable | What it does |
| --- | --- |
| `SMOKE_BREAK_ENTERPRISE` | `1` turns on strict mode: the hub refuses to start (exit status 78, listing what's missing) without `SMOKE_BREAK_ACCESS_TOKENS_FILE` (a shared token or none is refused), `SMOKE_BREAK_PUBLIC_HOST`, and `SMOKE_BREAK_PROXY_SECRET` or `SMOKE_BREAK_SOCKET`, or with a non-loopback `HOST` and no proxy secret; and owner approval stays on for every team (switching it off is refused; teams saved with it off get it back on at startup). Without it, each of those missing protections is a startup warning instead. |
| `PORT` | Port for `npm run server` (default 8787). |
| `HOST` | Address `npm run server` listens on (default `127.0.0.1`). Set it only when the TLS proxy runs on another machine (in strict mode, only with `SMOKE_BREAK_PROXY_SECRET`). |
| `SMOKE_BREAK_SOCKET` | Listen on this Unix socket (created `0660`) instead of `HOST`/`PORT`; only the hub's user and group can connect, and the peer is taken to be the proxy (its `X-Forwarded-For` is believed). |
| `SMOKE_BREAK_PROXY_SECRET` | A secret (16 to 512 printable characters without spaces, e.g. `openssl rand -hex 32`) the proxy must send in `X-Smoke-Break-Proxy`. Connections without it are refused, and `X-Forwarded-For` is only believed with it. Recommended whenever other users can log in to the hub's machine (or use `SMOKE_BREAK_SOCKET`). |
| `SMOKE_BREAK_ACCESS_TOKENS_FILE` | File of `label:token` lines, one per person (see above), at most 50,000 lines. Must be `chmod 600`. Re-read within about two seconds of a change, without a restart; removing a line revokes it and closes that label's connections. While it's broken, no token is valid. Can't be combined with `SMOKE_BREAK_ACCESS_TOKEN`. |
| `SMOKE_BREAK_ACCESS_TOKEN` | A single token shared by everyone, instead of the file: the weaker mode (no per-person revocation or limits; anyone holding it can block team creation hub-wide). Use a long random value (e.g. `openssl rand -hex 32`). Changing it locks every app out until it has the new one. |
| `SMOKE_BREAK_PUBLIC_HOST` | The hostname(s) the hub answers to, comma-separated (e.g. `breaks.example.com`). Connections for any other `Host` are refused, which stops DNS-rebinding attacks from web pages. Strongly recommended. |
| `SMOKE_BREAK_TRUST_PROXY` | The reverse proxies in front of the hub: IPs and CIDR ranges, comma-separated (e.g. `127.0.0.1` or `10.0.0.0/24`); `1` means loopback only. `X-Forwarded-For` is believed only from these. Unset: never believed. An invalid entry stops the hub from starting. |
| `SMOKE_BREAK_DATA_DIR` | Directory for `teams.json` (default: `.data/` in the repo). Must not be writable by other users. |
| `SMOKE_BREAK_CONNECTIONS_PER_IP` | Connections allowed from one address, or one token label, once they've identified themselves (default 500). Each app holds two connections, so the default fits about 250 people behind one office address. Connections that haven't identified themselves yet have a separate, smaller allowance (100 per address or label, 2000 in all). |
| `SMOKE_BREAK_MAX_CONNECTIONS` | Identified connections allowed in total (default 10000). |
| `SMOKE_BREAK_MAX_TEAMS` | Maximum number of teams (default 2000). When full, the least recently used junk team idle for a day is forgotten to make room: one that never had a break with two or more people and doesn't have two different token labels on its roster (one person's devices, however many, or a team made without per-person tokens). A team people really use is never forgotten for a new one: new teams are refused instead (`admin.ts delete-team` clears junk by hand). |
| `SMOKE_BREAK_TEAMS_PER_LABEL` | Teams one token label may hold (default 5): the teams it owns plus the teams it made that still exist, even after handing them over (so handing a team over doesn't free a slot). At the limit, that person can't make another team, and the owner of another team can't hand it to them. `admin.ts set-owner` isn't held to it, and says where it leaves the new owner. Teams saved before the hub kept who made them count for their owner at the time. |
| `SMOKE_BREAK_IDENTITIES_PER_LABEL` | Identities (devices) one token label may have in a team, counting people waiting for approval (default 3). Raise it if people use more devices. |
| `SMOKE_BREAK_ALLOWED_ORIGINS` | Extra web origins allowed to connect, comma-separated. Only needed if you serve the browser version from a different host than the hub. |
| `SMOKE_BREAK_MINUTE_MS` | Length of a break "minute" in ms (demo mode uses 3000). |

## Security

- **Identity:** each device has a private random ID that proves who it is. It's never sent to teammates; they see a one-way hash, so nobody can act as someone else. Names are unique within a team, offline members included, compared without case, width, invisible characters or common lookalike letters.
- **Access:** set `SMOKE_BREAK_ACCESS_TOKENS_FILE` (per-person tokens) or `SMOKE_BREAK_ACCESS_TOKEN` (one shared token; not both) so only people you give a token to can connect at all: the token is checked before the WebSocket is accepted. Invite codes are 10 characters. By default a new person with the right code still needs the owner's OK. With per-person tokens, each device on a team is tied to the label of the token it joined with and works under no other.
- **Revocation:** deleting someone's line from the tokens file (re-read within seconds) closes their connections and leaves them no way back in: not with their old devices under another token, not as a new device, not with an old code. A tokens file that turns unreadable, malformed or readable by others fails closed (no token is valid until it's fixed).
- **Removal:** the owner can remove anyone on the roster, online or not. That closes their connections, takes them out of any break, bans their identity for that team and replaces the invite code at once; their connections never receive the new code. With per-person tokens it removes the person (a label is one person): every device on the team under the same label goes in the same step, their waiting requests are dropped, and the label can't join that team again with any device. A device under the owner's own label is one of the owner's own: removing it removes and bans just that device, never the owner's label. The old code keeps working only for people still on the roster. Without per-person tokens, a removed person can come back only with a new identity *and* the current code *and* (with approval on) the owner's OK. Removals last until the hub admin lifts them (`admin.ts unban`); turning a waiting person away keeps them (and their token) from asking that team again for a day.
- **Team settings** can only be changed by the team owner. Meeting links are limited to Zoom meeting links, stored in one canonical form, and checked by the hub and again by each app. Only the owner receives the team's link; during a break, only the people taking part in it receive the meeting link.
- **Limits:** the hub caps message size, connections, sockets per person in a team (4; one more closes the oldest), roster size, waiting join requests (per team and per address or label; they expire after 3 days), identities per token label, new teams (per label, or per address and across the hub for connections without one), wrong invite-code guesses, message rates (per connection, and per label or address), how often someone can start a break (per roster entry, surviving reconnects, and per label), changes to a break (joining, leaving, and changing a pending break's length: 6 per 10 seconds per roster entry and per label; beyond that a "slow down" message and no change), other changes that send the whole team an update (coming online, going offline, a new name, an owner's settings: another 6 per 10 seconds per roster entry and per label; beyond that settings changes get a "slow down" message, a new name isn't taken, and coming and going reach the team with its next update, at the latest 10 seconds later), teams one label holds (5, counting teams it made and handed over), owner actions (removing, handing over and changing the code 5 times a minute; approving or turning away 20), how often a team's state is sent (changes within 150 ms share one update, a big team's updates are spaced further apart so that over time they average at most about 2 MB a second per team, and nothing is sent when nothing changed), and how much it buffers for slow readers (per connection and in total). Connections that haven't said who they are yet have their own small allowance (per address, with IPv6 grouped by /56, or per label; and in total), must do so within 3 seconds and after at most a couple of other messages, and can't use up anything identified connections need; identified connections are counted per address (IPv6 by /64) or, with a per-person token, per label. With per-person tokens, the message budget, wrong-code lockout, team creations and join requests are all per label, so one person can't lock out colleagues behind the same address. A connection is only closed for its own flooding, never because others used up a shared budget. Someone on the roster can always get back in with a right code, even while locked out for wrong guesses. Connections that stop answering pings are dropped. See `DEFAULT_LIMITS` in `server/hub.ts`. Teams nobody has used for 90 days are forgotten (checked at startup and every hour); when the hub is full, only junk teams are forgotten to make room (see `SMOKE_BREAK_MAX_TEAMS`).
- **Audit log:** refused upgrades have a small budget of their own, so strangers can't crowd other lines out; people with a token label and owners have one strangers can't use; security events are queued rather than dropped (see [Audit log](#audit-log)).
- **Proxies:** `X-Forwarded-For` is only believed from `SMOKE_BREAK_TRUST_PROXY` addresses (or the Unix socket), and, with `SMOKE_BREAK_PROXY_SECRET` set, only along with the secret; connections without the secret are refused.
- **Origins:** the standalone hub only accepts connections that carry an `Origin` from the desktop app, from origins in `SMOKE_BREAK_ALLOWED_ORIGINS`, or from pages on its own `SMOKE_BREAK_PUBLIC_HOST`, so other web pages can't drive it. Clients that send no `Origin` (anything that isn't a browser) aren't limited by this check, only by the access token. The dev server's hub also accepts pages it serves on `localhost`. The dev and preview servers send `frame-ancestors 'none'` and `nosniff`; the dev server refuses to serve the team file, `.env` files, keys and the security review notes (the preview server only serves the built app).
- **Desktop app:** it has a content security policy and can only open Zoom meeting links. The enterprise build (`npm run desktop:build:enterprise`) locks it to your hub, pins its content security policy to that hub and its meeting links to your Zoom host; a plain `npm run desktop:build` lets it connect to any `wss:` host.

### Security model

| Who | Can | Can't |
| --- | --- | --- |
| **Outsider** (no token, on a hub that requires one) | Be refused before a connection is set up (HTTP 401). | Hold a connection open, create or join teams, learn whether a code exists, or crowd other lines out of the audit log. |
| **Local user on the hub's machine** (no token) | Connect to the hub's port like an outsider. | With `SMOKE_BREAK_PROXY_SECRET` or `SMOKE_BREAK_SOCKET`: connect at all, or pose as other addresses. Without either, they can put any address in `X-Forwarded-For`. |
| **Someone with a token** | Create teams (within their quota: with a per-person token, 20 a day and at most 5 held at a time, counting the ones they made and handed over); ask to join a team whose current code they have; a teammate from before the upgrade can also ask with the team's old 6-character code until the owner replaces it. | Join without the owner's OK (when approval is on); get in with any other old code; use another person's device identity; with a per-person token, join a team they were removed from or ask again within a day of being turned away, under any identity (with a shared token, those bans hold for the device that was removed or turned away; a new device needs the current code and, with approval on, the owner's OK). |
| **Member** | See the roster and who's online; start, join and leave breaks, and change the length of one they started before anyone joins (a few changes per 10 seconds); come and go and change their name (a few times per 10 seconds; name changes are logged); get the meeting link while in a break; see the invite code (and pass it on). | Change settings, see the team's link outside a break, see who's waiting or anyone's token label, let people in, remove people. |
| **Owner** | Everything a member can, plus: settings (including approval, except in strict mode; a few changes per 10 seconds), the team's link, whose token each member and waiting person used, approve or turn away, remove, change the code, hand the team over (a few times a minute; with per-person tokens, only to someone below the teams-per-label limit). | Read other teams; see anyone's private ID or token. |
| **Revoked person** (line deleted from the tokens file) | Nothing. | Connect, or use any of their devices with someone else's token. |
| **Hub admin** | Everything in `teams.json` (codes, links, rosters) and the audit log; edit or revoke tokens; with `server/admin.ts`: print a team's code, reassign owners, lift bans, delete teams. | (Trust the admin: they run the hub.) |

What the pieces protect against, and what they don't:

- **Access tokens** keep people without one out of the hub entirely: no token, no connection. A shared token is only as secret as the least careful person who has it, can't be revoked for one person, and gives no per-person limits: anyone holding it can use up the hub-wide allowance for new teams and so block team creation for everyone. Per-person tokens can be revoked one at a time, and tie devices, bans and quotas to a person (one label per person). A token built into an app is readable by anyone who has that app.
- **Approval** means knowing the code isn't enough to join: the owner decides. It doesn't stop a member from passing on what they see (the code, the roster, a meeting link while in a break).
- **Removal** stops a removed device and, with per-person tokens, the removed person (all their devices, and their token for that team). It can't take back what they already saw, such as a meeting link: change the Zoom meeting's passcode if that matters.
- **Rate limits** bound how much one connection, address or token label can cost the hub; they don't stop a large distributed attack. On a hub without per-person tokens, people who share an address with an attacker (one office NAT) share its message budget (though only the flooding connection is ever closed), and on an open hub (no token at all) many addresses can still fill the allowance for new connections; with per-person tokens, limits are per person.
- **The hub must sit behind TLS** (`wss://`): tokens, codes and links travel over the connection. Ideally keep it reachable only on your VPN or behind an SSO proxy, so strangers can't reach it at all.

### Limits of this design

- **A token is a password, one per person.** Access rests on a bearer token per person (and, for each device, a random device ID the app keeps). Whoever has a person's token, and gets past the owner's approval, is that person to the hub until their line is deleted from the tokens file. Nothing ties a token to a device or a piece of hardware.
- **There is no single sign-on.** The hub doesn't talk to your identity provider: people get their token from whoever runs the hub, and leaving the company doesn't cut them off until their line is deleted.
- **The Mac app protects what it stores from other user accounts and from a stolen, locked laptop (with FileVault), not from malware running as the same user.** See [Where secrets are stored](src-tauri/SIGNING.md#where-secrets-are-stored).
- **Whoever runs the hub can read everything it holds:** names, who is on which team and who is online, token labels, invite codes and meeting links. `teams.json` holds the teams with their rosters, labels, codes and links; the hub's memory also holds who is online and the breaks; the audit log has names, labels and client addresses (never codes or links).
- **Someone with a token can degrade the service, up to the per-person limits above** (for example by making their 5 teams, sending join requests up to their quota, holding their share of connections, or using up their share of messages and team updates). The audit log has it under their label: each team they make (`create`), their join requests (`join-requested`), their name changes (`rename`) and the limits they reach (`limit`); lines they could repeat over and over are written a few a minute, with the rest counted in `suppressed`. Changes they make within the limits, such as joining and leaving breaks, aren't logged one by one. Deleting their line stops them; teams they made stay until `admin.ts delete-team` (or 90 idle days).

None of this needs code changes to strengthen: make the hub reachable only on your VPN or zero-trust network, so only managed devices can get to it at all; when a device is lost or someone leaves, delete (or replace) that person's line in the tokens file, which closes their connections within seconds; and alert on the audit events that matter: `limit` (someone hitting a limit), `transfer-owner`, `owner-token-revoked` (a team whose owner is gone) and `audit-dropped` (log lines lost).

**For a company deployment**, work through the [Enterprise deployment checklist](#enterprise-deployment-checklist): `SMOKE_BREAK_ENTERPRISE=1`, a per-person tokens file (no shared token), `SMOKE_BREAK_PUBLIC_HOST`, the hub behind TLS (ideally also the VPN or SSO proxy) with a proxy secret or on a Unix socket, a dedicated user under systemd, and the app built with `npm run desktop:build:enterprise` and signed as in [src-tauri/SIGNING.md](src-tauri/SIGNING.md). A plain `npm run desktop:build` is for trying it out.

## Development

```sh
npm test            # hub, protocol and break state machine tests
npm run typecheck
npm run build       # browser build into dist/
```

| Path | What |
| --- | --- |
| `shared/protocol.ts` | Messages, types and validation shared by the apps and the hub |
| `server/breakMachine.ts` | Pure break state machine: idle → pending → lighter → lit → out |
| `server/hub.ts` | WebSocket hub: teams, rosters, approvals, invite codes, timers, identity and limits |
| `server/persistence.ts` | The saved team file: format, migration from older hubs, atomic writes |
| `server/accessTokens.ts` | Shared and per-person access tokens |
| `server/addresses.ts` | Client addresses, trusted proxies, Host and Origin checks |
| `server/audit.ts` | The throttled audit log |
| `server/names.ts` | Display names: cleaning and lookalike-proof comparison |
| `server/admin.ts` | Admin CLI: list teams, print a team's code, reassign an owner, lift bans, delete a team |
| `server/limits.ts` | Rate limiters used by the hub |
| `server/meeting.ts` | Meeting providers (fixed Zoom link today; creating a fresh meeting per break via the Zoom API is planned) |
| `server/main.ts` | Standalone hub (`npm run server`) |
| `src/widget/` | The floating pack: sprites, animation scene, speech bubble, input |
| `src/widget/skins.ts` | Pack and lighter skins |
| `src/widget/theme.ts` | Break style names and their wording |
| `src/widget/styles/` | Each break style's look and animation (smoke, water, coffee, donut) |
| `src/appearance.ts` | Your size, style and skin choices, synced across your windows |
| `src/overlay.ts` | Desktop overlay window: click-through, dragging, tray sync |
| `src/panel.ts` | Desktop Settings window |
| `src/main.ts` | Browser version: fake desktop plus team panel |
| `src/shell.ts` | Onboarding, team panel and settings UI shared by both |
| `src-tauri/` | Tauri app: windows, menu-bar icon, launch at login |
| `scripts/make-icons.ts` | Renders the app and menu-bar icons from the pack sprites |
| `brag-output/` | The promo video and the scripts that make it |

During development the hub runs inside the Vite dev server (see `vite.config.ts`), so `npm run dev` and `npm run desktop` need nothing else.

## License

[MIT](LICENSE)
