# Hosting a Smoke Break hub

The hub is the small server every Smoke Break app connects to. On one computer, `npm run desktop` starts one for you. For a team on different computers, run it on a machine everyone can reach and put HTTPS in front of it. This guide covers that setup, what to check before a company rollout, and day-to-day admin.

[src-tauri/SIGNING.md](../src-tauri/SIGNING.md) covers shipping the Mac app itself: signing, notarizing and rolling it out.

> **The dev and preview servers are not a hub deployment.** `npm run dev` and `npm run share` run a hub inside Vite for development and quick tests on a network you trust. They use plain HTTP and serve the project's files. Don't expose them to the internet or put a tunnel in front of them.

## Contents

- [Company rollout checklist](#company-rollout-checklist)
- [Setting up the hub](#setting-up-the-hub)
  1. [Give each person a token](#1-give-each-person-a-token)
  2. [Put HTTPS in front of it](#2-put-https-in-front-of-it)
  3. [Run it as a service](#3-run-it-as-a-service)
  4. [Build the app for your hub](#4-build-the-app-for-your-hub)
- [The team file](#the-team-file)
- [Upgrading from an older hub](#upgrading-from-an-older-hub)
- [Admin tasks](#admin-tasks)
- [Audit log](#audit-log)
- [Hub settings](#hub-settings)
- [Security model](#security-model)

## Company rollout checklist

For a company rollout you need every item below. The setup steps after it explain each one.

- [ ] **Strict mode is on** (`SMOKE_BREAK_ENTERPRISE=1`). The hub then refuses to start (exit status 78, listing what's missing) unless the rest of this list is in place. See [what strict mode checks](#what-strict-mode-checks).
- [ ] **A per-person tokens file** in `SMOKE_BREAK_ACCESS_TOKENS_FILE`, one line per person, file mode `0600`. No shared `SMOKE_BREAK_ACCESS_TOKEN`. ([Step 1](#1-give-each-person-a-token))
- [ ] **An HTTPS reverse proxy on the same machine as the hub**, so apps connect over `wss://`. Add either a proxy secret (`SMOKE_BREAK_PROXY_SECRET`) or a Unix socket (`SMOKE_BREAK_SOCKET`) so nothing can connect around the proxy. ([Step 2](#2-put-https-in-front-of-it))
- [ ] **`SMOKE_BREAK_PUBLIC_HOST`** set to the hub's hostname.
- [ ] **A dedicated user and the systemd service** below, with a `0700` data directory and a `0600` settings file. ([Step 3](#3-run-it-as-a-service))
- [ ] **The app built with `npm run desktop:build:enterprise`**, then signed, notarized and rolled out as described in [SIGNING.md](../src-tauri/SIGNING.md#2-build-time-settings-for-your-company). Not `npm run desktop:build`, and no `VITE_HUB_TOKEN`. ([Step 4](#4-build-the-app-for-your-hub))
- [ ] **You have a plan for people leaving.** Delete a person's line from the tokens file and the hub cuts them off within seconds. If they owned a team, hand it to someone else with [`admin.ts set-owner`](#admin-tasks). See also [A stolen laptop or a departed employee](../src-tauri/SIGNING.md#a-stolen-laptop-or-a-departed-employee).
- [ ] **Audit log collection and alerts.** Alert at least on `limit`, `transfer-owner`, `owner-token-revoked` and `audit-dropped`. ([Audit log](#audit-log))

Even better, make the hub reachable only on your VPN or behind your single sign-on proxy, so strangers can't reach it at all.

### What strict mode checks

The hub can't see the HTTPS proxy, only what you tell it about it. With `SMOKE_BREAK_ENTERPRISE=1`:

- It refuses to start without a per-person tokens file (it refuses a shared token, or none), without `SMOKE_BREAK_PUBLIC_HOST`, and without either `SMOKE_BREAK_PROXY_SECRET` or `SMOKE_BREAK_SOCKET`.
- It refuses to listen on a network address other machines can reach (a non-loopback `HOST`), because the hop from the proxy to the hub isn't encrypted. If you've encrypted that hop some other way, set `SMOKE_BREAK_ENCRYPTED_HOP=1`; the hub then also requires `SMOKE_BREAK_PROXY_SECRET` and `SMOKE_BREAK_TRUST_PROXY`.
- On a loopback `HOST` with a proxy secret and no `SMOKE_BREAK_TRUST_PROXY`, it trusts the client address the proxy reports from loopback, so the audit log names the real client rather than the proxy.
- Owner approval stays on for every team. Owners can't switch it off, and teams saved with it off get it switched back on at startup.

`SMOKE_BREAK_ENTERPRISE` accepts `1`, `true`, `yes` or `on`. Any value the hub doesn't recognize stops it with exit status 78.

## Setting up the hub

Run the standalone hub behind an HTTPS reverse proxy:

```sh
SMOKE_BREAK_ENTERPRISE=1 \
SMOKE_BREAK_ACCESS_TOKENS_FILE=/etc/smoke-break/tokens \
SMOKE_BREAK_PUBLIC_HOST=breaks.example.com \
SMOKE_BREAK_TRUST_PROXY=127.0.0.1 \
SMOKE_BREAK_PROXY_SECRET=… \
SMOKE_BREAK_DATA_DIR=/var/lib/smoke-break \
npm run server            # listens on 127.0.0.1:8787 (set HOST and PORT to change it)
```

### 1. Give each person a token

`SMOKE_BREAK_ACCESS_TOKENS_FILE` points at a file with one `label:token` line per person. Lines starting with `#` are comments.

```text
# label:token, one per line. Labels show up in the audit log; tokens never do.
# Make each token with: openssl rand -hex 32
alice:4f9c2e0b…
bob:9a01d7c3…
```

- **Labels** are 1 to 64 letters, digits and `. _ @ + -`, starting with a letter or digit.
- **Tokens** are 16 to 512 printable characters with no spaces.
- The file can have up to 50,000 lines.

The app sends its token when it connects, and the hub checks it before accepting the connection. Without a valid token there's no connection at all (HTTP 401), so strangers can't even hold a connection open.

**A label is one person. Never give one line to a group.** The hub ties devices, bans, limits and removal to the label. Removing one of someone's devices removes all their devices under that label and bans the label from that team. (An owner removing one of their own devices removes just that device.) A shared line can only be revoked for everyone on it at once.

**The file must be readable only by the hub's user** (`chmod 600`), or the hub refuses to start. It also refuses a malformed or oversized file, naming the bad line but never the token.

**Changes take effect within about two seconds, with no restart.** Delete a line to revoke that person. The hub then:

- closes their connections,
- drops their pending join requests,
- refuses every device they joined with, whatever token or device they try next.

The one exception is a device that joined before the hub used per-person tokens and hasn't connected since. No token is tied to it yet (see [Switching to per-person tokens](#switching-to-per-person-tokens)).

If the revoked person owned a team, the audit log says so (`owner-token-revoked`, with the team's ref) so you can hand the team over with `admin.ts set-owner`.

**Edit the file by writing a complete new file and renaming it over the old one**, not by editing it in place:

```sh
install -m 600 -o smoke-break tokens.new /etc/smoke-break/tokens.tmp && mv /etc/smoke-break/tokens.tmp /etc/smoke-break/tokens
```

If the hub ever reads a file that's unreadable, malformed or has the wrong permissions, it fails closed: **no token is valid until you fix the file**. The hub refuses new connections and disconnects everyone connected with a per-person token is disconnected. Their apps keep their team and keep retrying. The log says why, once.

#### The shared-token alternative

`SMOKE_BREAK_ACCESS_TOKEN` sets one token for everyone instead of the file. You can't use both; the hub refuses to start with both set. The shared token is weaker by design:

- You can't revoke it for one person.
- Limits apply per address and across the hub instead of per person.
- Anyone holding it can use up the hub-wide allowance for new teams and block team creation for everyone.
- Changing it locks every app out until each one has the new token.

Strict mode refuses a shared token. Outside strict mode, the hub prints a warning at startup for each recommended protection it's missing. Those are a shared token or none at all, no `SMOKE_BREAK_PUBLIC_HOST`, `SMOKE_BREAK_TRUST_PROXY` without a proxy secret or socket, and a non-loopback `HOST`.

### 2. Put HTTPS in front of it

Any reverse proxy that handles WebSockets works, such as Caddy, nginx or a cloud load balancer. It should:

- handle HTTPS for your hostname (say `breaks.example.com`),
- forward `/ws` to the hub,
- pass the `Host` header through,
- set `X-Forwarded-For` to the client's address.

The hub listens on `127.0.0.1` by default, so other machines can only reach it through the proxy.

**Tell the hub which proxies to trust.** List the proxy's address in `SMOKE_BREAK_TRUST_PROXY` (IPs or CIDR ranges, comma-separated; `1` means loopback only). The hub believes `X-Forwarded-For` only from those addresses and uses the right-most entry that isn't one of them. With two proxies in a row, such as a CDN and nginx, list both.

**Keep the proxy on the same machine as the hub.** The proxy decrypts HTTPS, so the hop from it to the hub is plain, unencrypted `ws://`. If the proxy runs on another machine, anyone on the network between them can read every access token, the proxy secret, invite codes and meeting links. If it has to run elsewhere, encrypt that hop yourself (a private link, WireGuard, or HTTPS ending on the hub's machine), then set `SMOKE_BREAK_ENCRYPTED_HOP=1`. The hub can't check this; it takes your word.

**If anyone else can log in to the hub's machine, use a proxy secret or a Unix socket.** Any process on the machine can connect to `127.0.0.1` directly, skip the proxy and fake its own `X-Forwarded-For`, to pose as other addresses or get a colleague's address locked out.

- **Proxy secret.** Set `SMOKE_BREAK_PROXY_SECRET` to a long random value (`openssl rand -hex 32`) and have the proxy send it in an `X-Smoke-Break-Proxy` header. The hub refuses every connection without it, and only believes `X-Forwarded-For` when it's present. Keep the secret where other users can't read it: the hub's settings file (`0600`) and a proxy config file only root can read.
- **Unix socket.** Set `SMOKE_BREAK_SOCKET=/run/smoke-break/hub.sock` and the hub listens there instead of on a port (`HOST`, `PORT` and `SMOKE_BREAK_TRUST_PROXY` then don't apply). The hub creates the socket with mode `0660`, so only the hub's user and group can connect. Put the proxy's user in the hub's group, and nobody else. A socket left over from a crash is removed at startup; anything else at that path stops the hub from starting.

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

**Don't log request headers at the proxy.** Each app sends its access token in the `Sec-WebSocket-Protocol` header (base64url after `sb.token.`). A proxy log that records request headers would therefore hold every token. The examples above don't log headers. If you turn on access logging, leave that header out or mask it, and protect any log that recorded it as carefully as the tokens file.

### 3. Run it as a service

Run the hub under a supervisor such as systemd so it comes back after a crash or reboot. It saves pending changes and closes connections cleanly on `SIGTERM` and `SIGINT`.

If it can't start, it exits with:

- **status 78** when only an admin can fix the problem. Examples are an unreadable or invalid team file, a data directory other users can write to, a bad tokens file, an invalid setting, something strict mode requires, a file in the way of `SMOKE_BREAK_SOCKET`, or no permission to listen.
- **status 1** for problems that may clear by themselves, such as the port still being in use by a hub that's shutting down.

Restarting on 78 changes nothing, so the service below doesn't. It also gives up after 5 failed starts in 5 minutes.

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

The data directory must not be writable by other users, or the hub refuses to start. The settings file (`/etc/smoke-break/env`) may hold secrets, so keep it at `0600`.

### 4. Build the app for your hub

**For a company rollout, use the enterprise build** and follow [SIGNING.md](../src-tauri/SIGNING.md) for its settings, signing, notarization and rollout:

```sh
VITE_SERVER_URL=wss://breaks.example.com/ws \
SMOKE_BREAK_MEETING_HOST=example.zoom.us \
APPLE_SIGNING_IDENTITY="Developer ID Application: Example Inc (TEAMID1234)" \
npm run desktop:build:enterprise
```

The enterprise build:

- requires a `wss://` `VITE_SERVER_URL` and a Zoom `SMOKE_BREAK_MEETING_HOST`, and refuses `VITE_HUB_TOKEN`;
- locks the app to your hub, with no **Server** field, so nobody can point it at another hub;
- only opens meeting links on your Zoom host;
- restricts the app's content security policy to your hub;
- checks the finished app. If a check fails, don't ship that build.

Each person enters their own token in the app.

**Just trying it out?** `npm run desktop:build` builds an app you point at a hub with the **Server** field during setup, or with `VITE_SERVER_URL` at build time. Without either it connects to `ws://localhost:8787/ws`. Its content security policy allows connections to any `wss:` host, so don't roll it out to a company.

Both builds put `Smoke Break.app` and a `.dmg` in `src-tauri/target/release/bundle`. The app only accepts `wss://` addresses, apart from `localhost`.

**Update the apps and the hub together.** Older apps don't send a token when connecting, so a hub that requires tokens refuses them.

## The team file

The hub saves teams to `$SMOKE_BREAK_DATA_DIR/teams.json` (by default `.data/teams.json` in the repo), readable only by the user running the hub. The file holds every invite code and Zoom link, so keep it away from anything a web server serves and out of backups other people can read. Breaks in progress live only in memory, so restarting the hub ends them.

Saves are atomic. The hub writes a fresh, randomly named temporary file and renames it into place, never following a symlink.

**If the file can't be used, the hub refuses to start** (exit status 78) rather than start with no teams, which would make every app forget its team. That happens when the file can't be read (wrong owner or permissions), isn't a valid team list, or contains no valid team at all. The error names the file and, for a corrupt file, the `teams.json.corrupt-<timestamp>` copy it kept. Fix or restore the file, or move it away if you really want to start with no teams.

If only some entries are invalid, the hub starts without them. It first saves the file as it was in `teams.json.partial-<timestamp>` and lists each dropped entry on stderr.

All these backup copies are `0600`. The hub doesn't write a copy that's identical to an existing one, and keeps only the 5 newest of each kind, so restarting repeatedly on a bad file won't fill the disk.

## Upgrading from an older hub

On first start, the hub converts the team file to the current format and keeps the old one as `teams.json.pre-roster-<timestamp>`.

- Everyone the old hub remembered becomes a team member. They're shown without a name until they reconnect.
- The hub keeps owners and removals, and switches approval on for every team.
- Teams with an old 6-character invite code get a new 10-character one. Members still get back in with the old code and then receive the new one.
- Teammates the old hub didn't remember (older hubs only remembered each team's owner) aren't turned away. Their app's attempt with the old 6-character code becomes a join request the owner sees under **waiting**. This works while approval stays on and until the owner replaces the invite code. After that, the old code no longer works for anyone not on the team, and the owner shares the current code instead.
- Teams from before owners existed have nobody to approve anyone, so nobody gets in until you assign an owner with `admin.ts set-owner`. The audit log names each such team once (`ownerless-team`), and `admin.ts list` shows who has asked to join it.

### Switching to per-person tokens

Team members from before per-person tokens (from an older hub, or added under a shared token or none) have no token tied to them yet. The hub ties each entry to the first token it's used with:

- **The owner's own entry** gets tied to the owner's token straight away, without approval.
- **Everyone else** needs the owner's approval once, on any team that requires approval (every team in strict mode). Their first attempt moves them to **waiting**, with their name and their token's label. Once approved, they get back in with the code they have, even an old one, and receive the current one.
- **On a team with approval off** (outside strict mode), the hub ties the first token used without asking.
- **A token whose label was removed from the team**, or turned away from it, gets refused. The hub then drops that entry from the team and bans it.

The audit log records each of these (`unlabeled-member`). In strict mode, the startup `load` line counts the entries not yet tied to a token (`unlabeledMembers`).

Until an entry is tied, whoever has that device can tie it to any valid token. That matters most for the owner's entry, which skips approval. **Have owners reconnect soon after the switch**, and check that the `unlabeled-member` lines marked `owner` show the label you expect.

## Admin tasks

`server/admin.ts` works on the team file directly.

- **Run it as the hub's user** (e.g. `sudo -u smoke-break …`) with the same `SMOKE_BREAK_DATA_DIR`, or pass `--file path/to/teams.json`. It refuses to run as anyone else, so it can't leave the file owned by the wrong user, and it keeps the file's permissions.
- **Stop the hub before any command that changes the file**, and start it again afterwards. A running hub would overwrite your change.

```sh
sudo -u smoke-break node server/admin.ts list                          # teams, members, labels, who's waiting (no codes or links)
sudo -u smoke-break node server/admin.ts codes <team-ref>              # print a team's current invite code
sudo -u smoke-break node server/admin.ts set-owner <team-ref> <id>     # hand a team to a member or waiting person    [hub stopped]
sudo -u smoke-break node server/admin.ts unban <team-ref> <id|label>   # lift a removal or denial                      [hub stopped]
sudo -u smoke-break node server/admin.ts delete-team <team-ref> --yes  # delete a team; its members' apps forget it     [hub stopped]
```

- **`list`** shows each team's owner label, when it was last used and whether it ever had a group break, which helps spot junk teams.
- **`set-owner`** is for when an owner has left or lost their token, and for teams from before owners existed. On a hub with per-person tokens, it refuses someone not yet tied to a token unless you add `--unlabeled`. It isn't held to the teams-per-person limit, and tells you where the change leaves the new owner.
- **`unban`** lifts a removal, for one device or a whole label. Removals last until you lift them. Someone turned away can ask again after a day without your help.
- **`delete-team`** without `--yes` only shows what it would delete.

## Audit log

The hub writes one JSON line to stdout for each event below. Under systemd, read it with `journalctl -u smoke-break`. Warnings and errors (startup problems, a broken tokens file, a dropped team) go to stderr.

Each line has a timestamp, the client's address and, with per-person tokens, the token's label. Lines never contain invite codes, access tokens, device IDs or meeting links.

| Event | Means |
| --- | --- |
| `load` | The hub started and read its team file. Includes counts of teams and of invalid and expired entries, whether strict mode is on (`enterprise`), the teams it switched approval back on for (`approvalSwitchedOn`), and in strict mode the members not yet tied to a token (`unlabeledMembers`). |
| `unlabeled-member` | A member from before per-person tokens was used with a token for the first time (`label`). They were tied to it (`bound`, plus `owner` if it's the owner), moved to the waiting list (`waiting`), or `dropped` because that label was removed or turned away. |
| `create` | A team was made. Includes the label's totals: `labelTeams` (teams counted against its limit), `labelOwns`, `labelCreated` (teams it made that still exist) and `labelCreatesToday`. |
| `join`, `join-requested`, `join-failed` | Someone joined, asked to join, or was refused (with the reason). |
| `rename` | A member connected under a new name (`from`, `to`). The log records a few a minute per person and counts the rest in `suppressed`. |
| `approve-member`, `deny-member` | The owner let someone in, or turned them away for a day. |
| `remove-member` | The owner removed someone. `alsoRemoved` lists their other devices under the same label; `ownDevice` marks one of the owner's own devices. |
| `transfer-owner` | The owner handed the team over. Includes the new owner's label (`toLabel`), who made the team (`createdBy`), and both labels' counts afterwards (`labelOwns`, `labelCreated`, `toLabelOwns`, `toLabelCreated`). |
| `rotate-code`, `settings` | The owner replaced the invite code, or changed settings. |
| `tokens-reloaded` | The tokens file was read again, with the labels it revoked. |
| `tokens-file-broken` | The tokens file can't be used. No token is valid until it's fixed. |
| `token-revoked` | Connections of a revoked label (or everyone's, while the file is broken) were closed. |
| `owner-token-revoked`, `ownerless-team` | A team's owner lost their token, or a team has no owner at all. An admin should run `set-owner`. |
| `team-forgotten` | A team was forgotten while the hub ran: unused for 90 days, or a junk team cleared to make room. The `load` line counts teams already that old at startup as `expired`. |
| `limit` | A limit was hit. `kind` says which: `unauthorized`, `origin`, `proxy-secret`, `bad-codes`, `join-leave`, `set-length`, `presence`, `rename`, `settings`, `teams-per-label` and others. |
| `suppressed`, `audit-dropped`, `audit-queued` | Lines held back by the log's own limits, with counts. |

**Alert at least on** `limit`, `transfer-owner`, `owner-token-revoked` and `audit-dropped`.

### How the log protects itself

So nobody can flood out the lines that matter, different kinds of lines draw from separate budgets:

- **Refused connections** (no token or a wrong one, wrong origin or host, missing proxy secret) can come from anyone who can reach the hub. They share one small budget, a burst of 10 and then 2 a second. An `audit-dropped` line counts the rest by kind once a minute.
- **Other lines from connections without a token label** (shared token or open hub) get up to 50 a second.
- **Lines from people with a token label, and owners' settings changes,** get up to 20 a second, which nothing else can use.
- **Security events** (removals, approvals and denials, ownership and code changes, revoked tokens, token reloads, forgotten and ownerless teams, `unlabeled-member`, and `load`) are never dropped for being over budget. They queue and are written in order at up to 20 a second. Only if 10,000 are waiting are more lost, and the hub says so (`audit-dropped` with `"class":"critical"`, and on stderr).

Lines a client can trigger over and over (failed joins, limit hits, name changes) are also limited to a few a minute per reason and per address or label. A periodic `suppressed` line counts the rest.

## Hub settings

| Variable | What it does |
| --- | --- |
| `SMOKE_BREAK_ENTERPRISE` | Turns on strict mode with `1`, `true`, `yes` or `on` (any case). Unset, empty, `0`, `false`, `no` or `off` leave it off. Any other value stops the hub (exit status 78). See [What strict mode checks](#what-strict-mode-checks). |
| `PORT` | Port for `npm run server`. Default `8787`. |
| `HOST` | Address `npm run server` listens on. Default `127.0.0.1`. Keep the default and run the HTTPS proxy on the same machine; see [step 2](#2-put-https-in-front-of-it). Any other address gets a startup warning, and strict mode refuses it unless `SMOKE_BREAK_ENCRYPTED_HOP` is on. |
| `SMOKE_BREAK_ENCRYPTED_HOP` | On/off. Only for a proxy on another machine: turn it on once the hop from that proxy to the hub is encrypted some other way. The hub can't verify this. It drops the warning and lets strict mode start, but then also requires `SMOKE_BREAK_PROXY_SECRET` and `SMOKE_BREAK_TRUST_PROXY`. |
| `SMOKE_BREAK_SOCKET` | Listen on this Unix socket (mode `0660`) instead of `HOST` and `PORT`. Only the hub's user and group can connect, and the hub treats whatever connects as the proxy. |
| `SMOKE_BREAK_PROXY_SECRET` | A secret (16 to 512 printable characters, no spaces) the proxy must send in `X-Smoke-Break-Proxy`. The hub refuses connections without it, and only believes `X-Forwarded-For` with it. Use it, or the socket, whenever other users can log in to the hub's machine. |
| `SMOKE_BREAK_ACCESS_TOKENS_FILE` | The per-person tokens file. See [step 1](#1-give-each-person-a-token). Can't be combined with `SMOKE_BREAK_ACCESS_TOKEN`. |
| `SMOKE_BREAK_ACCESS_TOKEN` | One token shared by everyone, instead of the file. The weaker option; see [the shared-token alternative](#the-shared-token-alternative). Use a long random value. |
| `SMOKE_BREAK_PUBLIC_HOST` | The hostname or hostnames the hub answers to, comma-separated. The hub refuses connections for any other `Host`, which blocks attacks where a web page tricks your browser into reaching the hub. Strongly recommended. |
| `SMOKE_BREAK_TRUST_PROXY` | The reverse proxies in front of the hub: IPs and CIDR ranges, comma-separated (e.g. `127.0.0.1` or `10.0.0.0/24`). An on value (`1`, `true`, `yes`, `on`) means loopback only; an off value means none. `X-Forwarded-For` is believed only from these addresses. When unset it's never believed, except in strict mode as described above. An invalid entry stops the hub (exit status 78). |
| `SMOKE_BREAK_DATA_DIR` | Directory for `teams.json`. Default `.data/` in the repo. Must not be writable by other users. |
| `SMOKE_BREAK_CONNECTIONS_PER_IP` | Connections allowed from one address, or one token label, once they've identified themselves. Default 500. Each app holds two connections, so the default fits about 250 people behind one office address. Connections that haven't identified themselves yet have a smaller separate allowance (100 per address or label, 2000 in total). |
| `SMOKE_BREAK_MAX_CONNECTIONS` | Identified connections allowed in total. Default 10000. |
| `SMOKE_BREAK_MAX_TEAMS` | Maximum number of teams. Default 2000. When it's full, the hub forgets the least recently used junk team that's been idle for a day to make room. A junk team never had a break with two or more people and doesn't have two different token labels on it. Teams people actually use are never forgotten; new teams are refused instead. |
| `SMOKE_BREAK_TEAMS_PER_LABEL` | Teams one person (token label) may hold. Default 5. This counts teams they own plus teams they made that still exist, even ones they handed over. At the limit they can't make another team, and nobody can hand them one. `admin.ts set-owner` isn't held to it. |
| `SMOKE_BREAK_IDENTITIES_PER_LABEL` | Devices one person may have in a team, including ones waiting for approval. Default 3. |
| `SMOKE_BREAK_ALLOWED_ORIGINS` | Extra web origins allowed to connect, comma-separated. Only needed if you serve the browser version from a different host than the hub. |
| `SMOKE_BREAK_MINUTE_MS` | Length of a break "minute" in milliseconds. Demo mode uses 3000. |

## Security model

### What's protected

- **Identity.** Each device has a private random ID that proves who it is. Teammates only ever see a one-way hash of it, so nobody can act as someone else. Names must be unique within a team, including offline members, and the comparison ignores case, character width, invisible characters and common lookalike letters.
- **Access.** With a tokens file, only people you give a token to can connect, and the hub checks the token before it accepts the connection. Invite codes are 10 characters. By default, someone with the right code still needs the owner's approval. With per-person tokens, each device is tied to the label it joined with and works under no other.
- **Revocation.** Deleting someone's line closes their connections within seconds and leaves them no way back in. They can't return with their old devices under another token, as a new device, or with an old code. The one exception is a device of theirs from before per-person tokens that hasn't connected since (see [Switching to per-person tokens](#switching-to-per-person-tokens)). A tokens file that becomes unreadable, malformed or readable by others fails closed.
- **Removal.** The owner can remove anyone on the team, online or not. That closes their connections, takes them out of any break, bans them from the team and replaces the invite code at once. They never receive the new code. With per-person tokens it removes the whole person: every device under their label, their pending requests, and any future attempt from that label. Without per-person tokens, a removed person needs a new identity, the current code and (with approval on) the owner's approval to come back.
- **Team settings.** Only the owner can change them. Meeting links must be Zoom meeting links. The hub stores each one in a standard form, and the hub and each app both check it. Only the owner sees the team's link outside a break; during a break only the people in it receive it.
- **Proxies.** The hub only believes `X-Forwarded-For` from trusted proxies or the Unix socket, and only together with the proxy secret when you've set one.
- **Origins.** The hub only accepts browser connections from the desktop app, from `SMOKE_BREAK_ALLOWED_ORIGINS`, or from pages on its own `SMOKE_BREAK_PUBLIC_HOST`, so other websites can't drive it. Non-browser clients send no origin, so only the access token limits them. The dev server also accepts pages it serves on `localhost`, refuses to serve the team file, `.env` files and keys, and sends headers that stop it being framed.
- **Desktop app.** It has a content security policy and can only open Zoom meeting links. The enterprise build locks it to your hub and your Zoom host.

### Limits the hub enforces

The hub caps, among other things:

- message size, connections per address or person, connections per person in a team (4; a fifth closes the oldest), and how much it buffers for slow readers;
- team size, pending join requests (they expire after 3 days), devices per person, and new teams per person (20 a day, 5 held at once);
- wrong invite-code guesses (never applied to existing members);
- message rates per connection and per person;
- break changes (joining, leaving, changing the length): 6 per 10 seconds per member and per person, then a "slow down" message;
- other changes that update the whole team (coming online, going offline, renaming, settings), at another 6 per 10 seconds;
- removing, handing over and changing the code, at 5 times a minute, and approving or turning people away, at 20 times a minute;
- team updates. The hub sends changes made within 150 ms together, and spaces big teams' updates to average at most about 2 MB a second.

Connections that haven't identified themselves must do so within 3 seconds and get their own small allowance, so they can't use up what identified connections need. A connection is only ever closed for its own flooding, never because someone else used up a shared budget. Connections that stop answering pings are dropped. Teams nobody has used for 90 days are forgotten. The exact numbers are in `DEFAULT_LIMITS` in `server/hub.ts`.

### Who can do what

| Who | Can | Can't |
| --- | --- | --- |
| **Outsider** (no token, on a hub that requires one) | Get refused before a connection is set up (HTTP 401). | Hold a connection open, create or join teams, learn whether a code exists, or crowd out the audit log. |
| **Someone on the network between the proxy and the hub** (only when `HOST` isn't loopback) | Read everything on that hop: access tokens, the proxy secret, invite codes, meeting links. | Anything, if the proxy is on the hub's machine or that hop is encrypted. |
| **Another user on the hub's machine** (no token) | Connect to the hub's port like an outsider. | With a proxy secret or socket: connect at all, or pose as other addresses. Without either, they can fake `X-Forwarded-For`. |
| **Someone with a token** | Create teams (with a per-person token, 20 a day and 5 at once); ask to join a team whose current code they have. A teammate from before an upgrade can also ask with the old 6-character code until the owner replaces it. | Join without the owner's approval (when it's on); use any other old code; use someone else's device; rejoin a team they were removed from, or ask again within a day of being turned away. |
| **Member** | See the team and who's online; start, join and leave breaks; change the length of a break they started before anyone joins; change their name (logged); get the meeting link during a break; see and share the invite code. | Change settings, see the team's link outside a break, see who's waiting or anyone's token label, let people in, or remove anyone. |
| **Owner** | Everything a member can, plus: change settings (approval only outside strict mode), see the team's link, see whose token each person used, approve or turn people away, remove people, change the code, and hand the team over (with per-person tokens, only to someone who has connected with their own token and is under their team limit). | See other teams, or anyone's private ID or token. |
| **Revoked person** | With someone else's token, use a device of theirs from before per-person tokens that hasn't connected since. It waits for the owner's approval under that token's label, or gets straight in on a team with approval off or if it's the owner's own entry. | Connect with their own token, or use any device they joined with under it. |
| **Hub admin** | Read everything in `teams.json` (codes, links, members) and the audit log; edit or revoke tokens; print codes, reassign owners, lift bans and delete teams with `admin.ts`. | (The admin runs the hub, so they must be trusted.) |

### What this doesn't protect against

- **A token is a password.** Whoever has someone's token, and gets past the owner's approval, is that person to the hub until their line is deleted. Nothing ties a token to a particular device. A shared token is only as secret as the least careful person holding it, and a token built into an app can be read by anyone who has the app.
- **There's no single sign-on.** The hub doesn't talk to your company's identity provider. People get their token from whoever runs the hub, and leaving the company doesn't cut them off until their line is deleted.
- **Approval and removal can't take back what people already saw.** A member can pass on the code, the team list or a meeting link from a break. If a removed person had the Zoom link, change the meeting's passcode.
- **The Mac app protects its stored secrets from other user accounts and from a stolen, locked laptop (with FileVault), but not from malware running as the same user.** See [Where secrets are stored](../src-tauri/SIGNING.md#where-secrets-are-stored).
- **The hub admin can read everything the hub holds.** That includes names, teams, who's online, token labels, invite codes and meeting links. The audit log has names, labels and client addresses, but never codes or links.
- **Devices from before per-person tokens aren't tied to a token until they're used with one.** Until then, whoever has the owner's old device and any valid token can take that team. See [Switching to per-person tokens](#switching-to-per-person-tokens).
- **The hub doesn't encrypt the hop from the proxy.** HTTPS ends at the proxy, so keep it on the hub's machine or protect that hop yourself.
- **Rate limits don't stop a large distributed attack.** Without per-person tokens, people who share an office address with an attacker share its message budget (though only the flooding connection is closed). With no token at all, many addresses can still fill the allowance for new connections.
- **Someone with a token can degrade the service, up to their own limits,** for example by making their 5 teams or using up their share of messages. The audit log records it under their label. Deleting their line stops them; teams they made stay until `admin.ts delete-team` or 90 idle days.

None of these need code changes to strengthen. Make the hub reachable only on your VPN or zero-trust network, delete or replace a person's token when a device is lost or they leave, and alert on the audit events that matter.
