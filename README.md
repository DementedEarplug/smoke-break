# Smoke Break

A pixel-art cigarette pack that floats on your screen. Click it to invite your team to a quick break; once two or more people light up, Zoom opens and the cigarette burns down as the timer (10–15 minutes, set per team and adjustable by whoever starts the break).

It runs as a **desktop overlay** (Tauri): a transparent, always-on-top pack you can drag anywhere, with a menu-bar icon. There's also a browser version of the same pack for quick testing.

## Desktop app

```sh
npm install
npm run desktop        # starts the hub + the overlay app (needs Rust)
npm run desktop:demo   # same, with 3-second "minutes"
npm run desktop:build  # builds Smoke Break.app and a .dmg in src-tauri/target/release/bundle
```

On first launch the **Settings** window opens: enter your name and start or join a team. After that the pack floats bottom-right. Clicks on the transparent space around it pass through to whatever is underneath.

The menu-bar icon has **Settings…**, **Do not disturb**, **Launch at login**, and **Quit**. The app has no Dock icon.

The built app connects to `ws://localhost:8787/ws` by default (run `npm run server`). Point it at a shared server with the **Server** field during onboarding, or bake one in with `VITE_SERVER_URL=wss://… npm run desktop:build`.

## Browser version

```sh
npm install
npm run dev     # http://localhost:5173
npm run demo    # same, but a "minute" lasts 3 seconds, so a 12-min break takes 36s
npm test        # break state machine tests
```

Create a team, then use **Open a teammate tab** to play the other side in a second tab (each tab is its own person).

To test with other people, run `npm run share`. It serves on your network at the printed `Network:` URL. For people outside your network, put a tunnel (e.g. `cloudflared tunnel --url http://localhost:4173`) in front of it. The hub only accepts WebSocket connections from pages it serves itself and from the desktop app; if a proxy changes the `Host` header, list the page's origin in `SMOKE_BREAK_ALLOWED_ORIGINS` (comma-separated).

## How to use the pack

- **Click the pack** to start a break, or to join someone else's.
- **Scroll on the pack** (or use − / +) to change the length before anyone joins.
- **Click the lighter** to light up: your cigarette comes out of the pack, tips sideways to catch in the flame, then flips upright beside the pack and Zoom opens.
- **Click your own cigarette** to put it back (before lighting) or stub out early.
- **Drag** to move the pack. **Right-click** for do-not-disturb.
- **Pinch** (or ⌃-scroll) on the pack to resize it. Size and pack/lighter skins are under **My pack** in settings; skins only change what you see.
- **Break style** in settings switches between **Smoke** (a cigarette pack and a lighter) and **Water** (a water cooler whose jug drains as the timer, and a cup to fill instead of a lighter). It's personal: teammates can use different styles for the same break.
- **Team settings** (name, Zoom link, default length) can only be changed by whoever created the team. The Zoom link must be a `zoom.us` (or `zoom.com` / `zoomgov.com`) https link, since everyone's machine opens it automatically.

## Layout

| Path | What |
| --- | --- |
| `shared/protocol.ts` | Types and constants shared by client and server |
| `server/breakMachine.ts` | Pure break state machine: idle → pending → lighter → lit → out |
| `server/hub.ts` | WebSocket hub: teams, invite codes, server-owned timers, identity and limits |
| `server/limits.ts` | Rate limiters used by the hub |
| `server/meeting.ts` | Meeting providers (`fixed-link` now; `zoom-api` is Option B) |
| `src/widget/` | The floating pack: sprites, animation scene, bubble, input |
| `src/widget/skins.ts` | Pack and lighter skins (palettes, pack styles, flame colors) |
| `src/widget/theme.ts` | Break styles (smoke / water): copy and the H2O cooler label |
| `src/appearance.ts` | Your size and skin choices, synced across windows |
| `src/overlay.ts` | Desktop overlay window: click-through, dragging, tray sync |
| `src/panel.ts` | Desktop "Team & settings" window |
| `src/main.ts` | Browser version: fake desktop + team panel |
| `src/shell.ts` | Onboarding, team panel, and settings UI shared by both |
| `src-tauri/` | Tauri app: windows, tray menu, launch at login |
| `server/main.ts` | Standalone hub (`npm run server`) |
| `scripts/make-icons.ts` | Renders the app and tray icons from the pack sprites |

The hub runs inside the Vite server (see `vite.config.ts`), and teams are saved to `.data/teams.json`. Break state lives in memory, so restarting the server ends any break in progress.

The hub doesn't trust clients: each device's private `clientId` proves who it is and is never sent to teammates (they see a one-way hash). It also limits message size, connections and new teams per address, wrong invite codes, and message rates (see `DEFAULT_LIMITS` in `server/hub.ts`; `SMOKE_BREAK_MAX_TEAMS` caps the team count). Teams nobody has used for 90 days are forgotten.
