# Smoke Break

A little pixel-art pack that floats on your desktop and gets your team on a break together.

Click the pack to invite your team. When a second person joins, a lighter appears; light up and everyone's Zoom call opens. The cigarette then burns down as the break timer (10–15 minutes).

Not a smoker? Switch to the **Water** style: a water cooler whose jug drains as the timer, with a cup to fill instead of a lighter. Styles and skins are personal, so smokers and non-smokers can share the same break and each see their own.

[![Smoke Break in action (20-second video)](brag-output/brag.jpg)](brag-output/brag.mp4)

> **Status:** a working prototype. The desktop app has only been built and tested on macOS so far; Windows and Linux are tracked in [#1](https://github.com/DementedEarplug/smoke-break/issues/1).

## How it works

There are two pieces:

- **The app**: the floating pack on each person's screen. It's a desktop overlay (built with [Tauri](https://tauri.app)) that sits on top of other windows; clicks on the empty space around it pass straight through. There's also a browser version of the same pack for testing.
- **The hub**: a small server that everyone on the team connects to. It keeps track of teams and runs the break timer, so everyone sees the same break at the same time.

For local development, one command starts both. For a real team, one person runs the hub somewhere everyone can reach (see [Running a shared hub](#running-a-shared-hub)).

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

In the **My pack** panel (in the Settings window on desktop, beside the team panel in the browser) you can change the size, the pack and lighter skins, and the **Break style** (Smoke or Water). These settings stay on your device and never change what teammates see.

## Running a shared hub

For people on different machines, run the hub where everyone can reach it.

**For a quick test with others**, serve the browser version and its hub on your network:

```sh
npm run share
```

Teammates open the printed `Network:` URL. For people outside your network, put a tunnel in front of it, e.g. `cloudflared tunnel --url http://localhost:4173`.

**For the desktop app**, run the standalone hub:

```sh
npm run server            # listens on ws://localhost:8787/ws (set PORT to change it)
```

Then point each app at it, either with the **Server** field during onboarding, or by building the address in:

```sh
VITE_SERVER_URL=wss://hub.example.com/ws npm run desktop:build
```

`desktop:build` produces `Smoke Break.app` and a `.dmg` in `src-tauri/target/release/bundle`. Without a server setting, the built app connects to `ws://localhost:8787/ws`. For a hub on the internet, put it behind HTTPS (so the address is `wss://`).

Teams are saved to `.data/teams.json`, readable only by the user running the hub. Breaks in progress live in memory, so restarting the hub ends them.

### Hub settings

| Environment variable | What it does |
| --- | --- |
| `PORT` | Port for `npm run server` (default 8787). |
| `SMOKE_BREAK_MAX_TEAMS` | Maximum number of teams (default 2000). When full, the least recently used empty team is dropped. |
| `SMOKE_BREAK_ALLOWED_ORIGINS` | Extra web origins allowed to connect, comma-separated. Only needed if a proxy changes the `Host` header. |
| `SMOKE_BREAK_MINUTE_MS` | Length of a break "minute" in ms (demo mode uses 3000). |

## Security

- **Identity:** each device has a private random ID that proves who it is. It's never sent to teammates; they see a one-way hash, so nobody can act as someone else. Names are unique within a team.
- **Team settings** can only be changed by the team owner, and meeting links are limited to Zoom (checked by the hub and again by each app).
- **Limits:** the hub caps message size, connections and new teams per address, wrong invite-code guesses, and message rates (see `DEFAULT_LIMITS` in `server/hub.ts`). Teams nobody has used for 90 days are forgotten.
- **Origins:** the hub only accepts connections from pages it serves itself and from the desktop app, so other websites can't connect to it from your browser.
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
| `src/widget/theme.ts` | Break styles (smoke / water) and their wording |
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
