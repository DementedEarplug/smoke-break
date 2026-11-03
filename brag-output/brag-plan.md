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

**Music:** 120 BPM (beat 0.5s, bar 2s), A minor, soft chiptune with a triangle bass, a mellow square lead, a soft kick and hats. Sound effects sit on the beat grid: pops on cigarette appearances, a lighter flick, and a stub-out.

## Storyboard (20.0s = 40 beats)

| # | Time | Beats | Scene |
|---|---|---|---|
| 1 | 0.0–3.0 | 0–6 | **Hook.** A big pack bobs on the desktop. The cursor clicks on beat 2: lid opens, a cigarette pops, and the bubble reads "Maya wants a 12-min smoke break." Text: "A cigarette pack that floats on your screen." |
| 2 | 3.0–6.0 | 6–12 | **Invite.** Three screens: Maya, Theo, Sam. The bubble lands on all three, then Theo (beat 8) and Sam (beat 9) join and their cigarettes pop in every pack. Text: "Click it. Your whole team gets the invite." |
| 3 | 6.0–10.0 | 12–20 | **Light up.** Close-up of Theo's pack. The lighter rises, the cursor clicks it on beat 14, then flame, the cigarettes rise and light, smoke, and the bubble "Opening Zoom". Text: "Two join. A lighter appears. Light up and Zoom opens." |
| 4 | 10.0–14.0 | 20–28 | **Timer.** Fast-forward burn: the ember flickers and ash drops, the bubble counts minutes down, then cigarettes stub out on beat 26 and the bubble reads "Break's over. Time to hop off Zoom". Text: "The cigarette is the timer." Sub: "10–15 minutes. Your team picks." |
| 5 | 14.0–17.0 | 28–34 | **Skins.** Seven packs, then eight lighters (lit) pop in on half-beats. Text: "Pick your pack. And your lighter." |
| 6 | 17.0–20.0 | 34–40 | **Outro.** Lit pack with three smoking cigarettes, the title SMOKE BREAK in the pixel font. Sub: "Lives in your menu bar. Mac desktop app for teams." |

Cuts dip through the background (old content out, new content in) on bar lines.
