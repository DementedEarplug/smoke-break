# Smoke Break — brag plan

**What it is:** A pixel-art cigarette pack that floats on everyone's screen. Click it to invite the team to a break; once two people join a lighter appears, lighting up opens Zoom, and the cigarette burns down as the timer.

**For:** Remote teams who miss the "anyone want to step out?" moment.

**Angle:** Play it straight. It's a real desktop app, and the cigarette is the progress bar. The joke is the premise, so the copy stays dry.

**Hook:** In the first second a cursor clicks the bobbing pack. The lid flips, a cigarette pops up, and a bubble says "Maya wants a 12-min smoke break."

**Highlights:**
1. One click invites the whole team (three screens, the invite lands on each).
2. Two join, a lighter appears, and lighting up opens Zoom.
3. The cigarette is the timer, burning down to "Break's over."
4. Bonus: pack and lighter skins.

**Punchline:** "Smoke Break. Lives in your menu bar."

**Tone:** default (punchy, playful, clean), leaning deadpan in the copy.

**Visual identity** (from `src/style.css`):
- Background: the app's fake-desktop gradient `#3b4a6b → #2a2f48 → #241f36` with a 24px grid.
- Colors: ink `#1a1020`, paper `#fffaf0`, red `#d23a3a`.
- Type: the project's own 3×5 bitmap font scaled up for headlines, plus SF Mono for small lines.
- Everything on screen is drawn by the real `Scene`, sprites, skins, and bubble art.

**Names on screen** are fictional (Maya, Theo, Sam). No real teams, codes, or links are shown.

**Music:** 120 BPM (beat 0.5s, bar 2s), A minor, soft chiptune with a triangle bass, a mellow square lead, a soft kick and hats. Sound effects sit on the beat grid: pops on cigarette appearances, a lighter click and flame, the catch, a stub-out, the cup filling, and the skin pops.

**v2 (slower cut):** same music, tempo, effects and skins-on-the-beat ending, stretched from 20s to 36s so every bubble and line has time to be read. It adds the new light-up (the cigarette is held sideways in the flame, then stands beside the pack, and Zoom opens a beat later) and the water style.

## Storyboard (36.0s = 72 beats)

| # | Time | Scene |
|---|---|---|
| 1 | 0–4 | **Hook.** The pack bobs on the desktop with "Click for a smoke break". The cursor clicks on 2.0: a cigarette pops and the bubble reads "Waiting for takers...". Text: "A cigarette pack that floats on your screen." |
| 2 | 4–10 | **Invite.** Three screens: Maya, Theo, Sam. The invite lands at 4.5, Theo joins at 6.5 (lighters appear), Sam joins at 9.0. Text: "Click it. Your whole team gets the invite." |
| 3 | 10–18 | **Light up.** Close-up of Theo's pack. He clicks the lighter at 11.5, his cigarette comes out, tips sideways, the lighter rises, the flame licks it at 12.25, and it catches at 12.9 and hops beside the pack. Zoom slides in at 14.0, and tiles land on 14.5, 15.0 and 15.5 (Sam lights up). Text: "Two join. A lighter appears. Light up and Zoom opens." |
| 4 | 18–23 | **Timer.** The cigarettes beside the pack burn down; the last minute slows for "Last drag!", and they stub out at 21.0 with "Break's over. Time to hop off Zoom". Text: "The cigarette is the timer." Sub: "10–15 minutes. Your team picks." |
| 5 | 23–27 | **Water.** The same break on Theo's screen (smoke) and Sam's screen (water cooler). Sam fills a cup at 24.0. Text: "Not a smoker? Switch to water." Sub: "Same break. Everyone picks their own style." |
| 6 | 27–33 | **Skins.** Seven packs pop on the beat, then eight lighters on the eighths, with the outro melody rising under the last of them. Text: "Pick your pack. And your lighter." |
| 7 | 33–36 | **Outro.** Lit pack with three cigarettes smoking beside it, and the title on the melody's peak. "Lives in your menu bar. A Mac desktop app for teams." |

Cuts dip through the background (old content out, new content in) on beats.
