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

1. **Start a team.** Whoever starts it becomes the team's **owner**, the only person who can change team settings.
2. **Add the Zoom link.** The owner opens **Settings** in the team panel and pastes the team's Zoom meeting link. It must be an `https://` link on `zoom.us`, `zoom.com` or `zoomgov.com`, because everyone's machine opens it automatically when a break starts.
3. **Invite people.** Share the invite code (desktop) or invite link (browser) from the team panel. Teammates enter it when they first open the app.
4. **Pick a default length** in Settings (10–15 minutes). Whoever starts a break can still change it before anyone joins.

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

**For real use**, run the standalone hub behind a TLS reverse proxy, so apps connect over `wss://`:

```sh
SMOKE_BREAK_ACCESS_TOKEN=your-long-random-token \
SMOKE_BREAK_PUBLIC_HOST=breaks.example.com \
SMOKE_BREAK_TRUST_PROXY=1 \
SMOKE_BREAK_DATA_DIR=/var/lib/smoke-break \
HOST=127.0.0.1 \
npm run server            # listens on port 8787 (set PORT to change it)
```

Generate the token once (e.g. `openssl rand -hex 32`) and keep it in the service's environment; a new token locks out every app until it has the new one.

1. **Put TLS in front of it.** Any reverse proxy that handles WebSockets works (Caddy, nginx, a cloud load balancer). It should terminate HTTPS for `breaks.example.com`, forward `/ws` to `127.0.0.1:8787`, pass the `Host` header through, and add the client's address to `X-Forwarded-For`. The hub uses the right-most entry, the one the last proxy added; with two proxies in a row (say a CDN and nginx), make the inner one restore the real client address first, or every client looks like the CDN. Bind the hub to `127.0.0.1` with `HOST` so nothing reaches it except through the proxy. Better still, keep the hub on your VPN or behind your SSO proxy as well.
2. **Run it under a supervisor** (systemd, launchd, Docker with a restart policy) so it comes back after a crash or reboot. It saves pending changes and closes connections cleanly on `SIGTERM` and `SIGINT`.
3. **Point each app at it**, either with the **Server** field during onboarding, or by building the address (and, optionally, the access token) in:

   ```sh
   VITE_SERVER_URL=wss://breaks.example.com/ws VITE_HUB_TOKEN=… npm run desktop:build
   ```

   `desktop:build` produces `Smoke Break.app` and a `.dmg` in `src-tauri/target/release/bundle`. Without a server setting, the built app connects to `ws://localhost:8787/ws`. The app only accepts `wss://` addresses, apart from `localhost`. Anyone who has an app with the token built in has the token, so only hand that build to people who should have access.

Teams are saved to `$SMOKE_BREAK_DATA_DIR/teams.json` (default: `.data/teams.json` in the repo), readable only by the user running the hub. The file holds every invite code and Zoom link, so keep it out of anything a web server serves and out of backups other people can read. Saves are atomic. If the file is ever unreadable, the hub keeps a `teams.json.corrupt-<timestamp>` copy and says so loudly on startup. Breaks in progress live in memory, so restarting the hub ends them.

The hub writes one JSON line to stdout for each join, failed join, new team, settings change, code rotation, member removal and limit hit, with a timestamp and the client's address. These lines never contain invite codes, access tokens, client IDs or meeting links. Collect them with your usual log tooling.

### Hub settings

| Environment variable | What it does |
| --- | --- |
| `PORT` | Port for `npm run server` (default 8787). |
| `HOST` | Address `npm run server` listens on (default: all interfaces). Use `127.0.0.1` when the TLS proxy runs on the same machine. |
| `SMOKE_BREAK_ACCESS_TOKEN` | If set, creating or joining a team requires this token. Use a long random value (e.g. `openssl rand -hex 32`). Changing it locks every app out until it has the new one. |
| `SMOKE_BREAK_PUBLIC_HOST` | The hostname(s) the hub answers to, comma-separated (e.g. `breaks.example.com`). Connections for any other `Host` are refused, which stops DNS-rebinding attacks from web pages. Strongly recommended. |
| `SMOKE_BREAK_TRUST_PROXY` | Set to `1` when the hub is behind a reverse proxy: the client address is then taken from the right-most `X-Forwarded-For` entry. Leave it unset otherwise, or anyone could pick their own address. |
| `SMOKE_BREAK_DATA_DIR` | Directory for `teams.json` (default: `.data/` in the repo). |
| `SMOKE_BREAK_CONNECTIONS_PER_IP` | Connections allowed from one address (default 500). Each app holds two connections, so the default fits about 250 people behind one office address. |
| `SMOKE_BREAK_MAX_CONNECTIONS` | Connections allowed in total (default 10000). |
| `SMOKE_BREAK_MAX_TEAMS` | Maximum number of teams (default 2000). When full, a team nobody has used for 7 days may be dropped to make room; if there isn't one, new teams are refused. |
| `SMOKE_BREAK_ALLOWED_ORIGINS` | Extra web origins allowed to connect, comma-separated. Only needed if you serve the browser version from a different host than the hub. |
| `SMOKE_BREAK_MINUTE_MS` | Length of a break "minute" in ms (demo mode uses 3000). |

## Security

- **Identity:** each device has a private random ID that proves who it is. It's never sent to teammates; they see a one-way hash, so nobody can act as someone else. Names are unique within a team, compared without case, width, invisible characters or common lookalike letters.
- **Access:** set `SMOKE_BREAK_ACCESS_TOKEN` so only people you give the token to can create or join teams. Invite codes are 10 characters (teams from before keep their 6-character code until the owner changes it). The owner can **change the invite code** and **remove members**; removed members can't rejoin.
- **Team settings** can only be changed by the team owner. Meeting links are limited to Zoom, stored in one canonical form, and checked by the hub and again by each app. Only the owner receives the team's link; everyone else gets it when a break starts.
- **Limits:** the hub caps message size, connections (per address and in total), team size, new teams (per address and across the hub), wrong invite-code guesses (per address and across the hub), message rates, how often one person can start a break, and how much it will buffer for a connection that stops reading. IPv6 addresses are grouped by /64. A member the team already knows can always get back in with the right code, even while their address is locked out for wrong guesses. Connections that don't identify themselves within 10 seconds, or stop answering pings, are dropped. See `DEFAULT_LIMITS` in `server/hub.ts`. Teams nobody has used for 90 days are forgotten.
- **Origins:** the standalone hub only accepts connections from the desktop app, from origins in `SMOKE_BREAK_ALLOWED_ORIGINS`, and from pages on its own `SMOKE_BREAK_PUBLIC_HOST`. The dev server's hub also accepts pages it serves on `localhost`.
- **Desktop app:** it has a content security policy and can only open Zoom links.

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
| `server/hub.ts` | WebSocket hub: teams, invite codes, timers, identity and limits |
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
