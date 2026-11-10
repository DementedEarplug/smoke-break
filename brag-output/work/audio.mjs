// Soundtrack + effects for the Smoke Break video, written as one piece.
// 120 BPM (beat 0.5s), A minor, 36s. Everything sits on the 16th-note grid from t=0.
import fs from 'node:fs';

const SR = 44100;
const DUR = 36;
const N = SR * DUR;
const L = new Float32Array(N);
const R = new Float32Array(N);
const BEAT = 0.5;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

let noiseSeed = 7;
const noise = () => {
  noiseSeed = (noiseSeed * 1103515245 + 12345) & 0x7fffffff;
  return (noiseSeed / 0x7fffffff) * 2 - 1;
};

function add(t0, len, gain, pan, gen) {
  const s0 = Math.floor(t0 * SR);
  const n = Math.floor(len * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < n; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const v = gen(i / SR, i);
    L[k] += v * gl;
    R[k] += v * gr;
  }
}

// One-pole lowpass state per voice.
function lp(cut) {
  const a = 1 - Math.exp((-2 * Math.PI * cut) / SR);
  let y = 0;
  return (x) => (y += a * (x - y));
}

const env = (t, a, d, len) => (t < a ? t / a : Math.max(0, 1 - (t - a) / d)) * (t > len ? Math.max(0, 1 - (t - len) / 0.05) : 1);

// ── Instruments ─────────────────────────────────────────────────────────────

function kick(t0, g = 0.8) {
  let ph = 0;
  add(t0, 0.35, g, 0, (t) => {
    const f = 45 + 110 * Math.exp(-t * 30);
    ph += (2 * Math.PI * f) / SR;
    return Math.sin(ph) * Math.exp(-t * 9);
  });
}

function clap(t0, g = 0.16) {
  const f = lp(3500);
  add(t0, 0.2, g, 0.1, (t) => f(noise()) * Math.exp(-t * 22) * (t < 0.012 ? 1.4 : 1));
}

function hat(t0, g = 0.05, pan = -0.3) {
  let prev = 0;
  add(t0, 0.06, g, pan, (t) => {
    const n = noise();
    const hp = n - prev;
    prev = n;
    return hp * Math.exp(-t * 70);
  });
}

function bass(t0, m, len, g = 0.32) {
  const f = mtof(m);
  const filt = lp(900);
  add(t0, len + 0.05, g, 0, (t) => {
    const ph = (t * f) % 1;
    const tri = 1 - 4 * Math.abs(ph - 0.5);
    return filt(tri) * env(t, 0.005, len * 3, len);
  });
}

function lead(t0, m, len, g = 0.08, pan = 0.25) {
  const f = mtof(m);
  const filt = lp(2200);
  add(t0, len + 0.05, g, pan, (t) => {
    const vib = 1 + 0.004 * Math.sin(t * 2 * Math.PI * 5.5) * Math.min(1, t * 4);
    const sq = (t * f * vib) % 1 < 0.5 ? 1 : -1;
    return filt(sq) * env(t, 0.004, len * 1.4, len);
  });
}

function pad(t0, notes, len, g = 0.05) {
  notes.forEach((m, i) => {
    const filt = lp(1200);
    const f = mtof(m);
    add(t0, len + 0.3, g, (i - 1) * 0.4, (t) => {
      const a = Math.min(1, t / 0.25) * (t > len ? Math.max(0, 1 - (t - len) / 0.3) : 1);
      const saw = ((t * f) % 1) * 2 - 1;
      const saw2 = ((t * f * 1.004) % 1) * 2 - 1;
      return filt((saw + saw2) * 0.5) * a;
    });
  });
}

// ── Effects (in key, tucked under the music) ────────────────────────────────

function pop(t0, m, g = 0.13, pan = 0) {
  const f = mtof(m);
  let ph = 0;
  add(t0, 0.18, g, pan, (t) => {
    ph += (2 * Math.PI * f * (1 + 0.5 * Math.exp(-t * 60))) / SR;
    return Math.sin(ph) * Math.exp(-t * 22);
  });
}

function click(t0, g = 0.05) {
  const filt = lp(5000);
  add(t0, 0.03, g, 0.2, (t) => filt(noise()) * Math.exp(-t * 200));
}

function flick(t0, g = 0.2) {
  // Striker scrape, then the flame catching.
  let prev = 0;
  add(t0, 0.07, g * 0.5, 0.3, (t) => {
    const n = noise();
    const hp = n - prev;
    prev = n;
    return hp * Math.exp(-t * 45);
  });
  const filt = lp(700);
  add(t0 + 0.05, 0.6, g, 0.3, (t) => filt(noise()) * Math.min(1, t / 0.04) * Math.exp(-t * 5));
}

function hiss(t0, len, g = 0.12) {
  const filt = lp(2500);
  add(t0, len, g, -0.2, (t) => filt(noise()) * Math.min(1, t / 0.02) * Math.exp(-t * 4));
}

function whoosh(tEnd, len = 0.35, g = 0.08) {
  const filt = lp(1500);
  add(tEnd - len, len + 0.1, g, 0, (t) => {
    const k = t / len;
    return filt(noise()) * (k < 1 ? k * k : Math.max(0, 1 - (k - 1) * 4));
  });
}

// ── Arrangement ─────────────────────────────────────────────────────────────

const CHORDS = {
  Am: { root: 45, tones: [57, 60, 64] },
  F: { root: 41, tones: [53, 57, 60] },
  C: { root: 48, tones: [55, 60, 64] },
  G: { root: 43, tones: [55, 59, 62] },
};
const CYCLE = ['Am', 'F', 'C', 'G'];
const BARS = [...CYCLE, ...CYCLE, ...CYCLE, ...CYCLE, 'F', 'Am'];
const LAST = BARS.length - 1;
const ARP = [0, 1, 2, 1, 2, 3, 2, 1]; // index into tones + octave
const ARP_B = [0, 2, 1, 3, 2, 1, 2, 3]; // variation for the middle section
/** The lead drops out under the skins pops and the ending. */
const LEAD_UNTIL = 27;

BARS.forEach((name, bar) => {
  const c = CHORDS[name];
  const t0 = bar * 4 * BEAT;
  const final = bar === LAST;
  // Drums.
  for (let b = 0; b < 4; b++) {
    const t = t0 + b * BEAT;
    if (final && b > 0) continue;
    if (b % 2 === 0 || bar === 0) kick(t, bar === 0 ? 0.6 : 0.75);
    if (bar > 0 && b % 2 === 1) clap(t);
    if (bar > 0 || b >= 2) {
      hat(t + BEAT / 2, 0.045);
      if (bar >= 1 && bar < LAST - 1) hat(t, 0.025, 0.3);
    }
  }
  // Bass: pulsing 8ths with an octave hop.
  if (!final) {
    for (let e = 0; e < 8; e++) {
      const m = c.root + (e === 3 || e === 7 ? 12 : 0);
      bass(t0 + e * (BEAT / 2), m, BEAT / 2 - 0.03, e % 2 === 0 ? 0.32 : 0.24);
    }
  } else {
    bass(t0, c.root, 1.8, 0.34);
  }
  // Pad under everything.
  pad(t0, c.tones, final ? 1.7 : 4 * BEAT - 0.05, final ? 0.045 : 0.035);
  // Lead arpeggio from bar 1.
  if (bar >= 1) {
    const arp = bar >= 9 && bar <= 12 ? ARP_B : ARP;
    for (let e = 0; e < 8; e++) {
      const t = t0 + e * (BEAT / 2);
      if (t >= LEAD_UNTIL) break;
      const i = arp[e];
      const m = (i === 3 ? c.tones[0] + 12 : c.tones[i]) + 12;
      lead(t, m, BEAT / 2 - 0.06, bar >= 3 ? 0.075 : 0.06);
    }
  }
});
// Outro melody: a short rising figure into the title, ending on A.
[
  [32.0, 72], [32.5, 74], [33.0, 76],
  [33.5, 72], [34.0, 69],
].forEach(([t, m], i) => lead(t, m, i === 4 ? 1.6 : 0.4, 0.08, 0));

// Effects on the grid.
click(2.0); pop(2.0, 76); // Maya clicks the pack
pop(4.5, 81, 0.1, -0.4); pop(4.5, 76, 0.08, 0.4); // invite lands
click(6.5); pop(6.5, 72, 0.12, 0); // Theo joins
pop(6.625, 69, 0.07, 0.3); // lighters pop up
click(9.0); pop(9.0, 76, 0.12, 0.4); // Sam joins
pop(9.125, 69, 0.07, 0.3);
click(11.5); pop(11.5, 64, 0.05, 0.3); // click the lighter
flick(12.25, 0.22); // flame licks the tip
pop(12.875, 69, 0.08, 0.2); hiss(12.875, 0.35, 0.05); // it catches
whoosh(14.0, 0.35, 0.05); // Zoom slides in
pop(14.5, 69, 0.06); pop(15.0, 72, 0.06); pop(15.5, 76, 0.06); // tiles
hiss(21.0, 0.6, 0.12); // stub out
click(24.0); [64, 69, 72, 76].forEach((m, i) => pop(24.0 + i * 0.125, m, 0.07, 0.4)); // cup fills
const PENTA = [69, 72, 74, 76, 79, 81, 84, 86];
for (let i = 0; i < 7; i++) pop(27.5 + i * 0.5, PENTA[i % PENTA.length], 0.12, -0.6 + i * 0.2);
for (let i = 0; i < 8; i++) pop(30.75 + i * 0.25, PENTA[i] + 12, 0.08, -0.6 + i * 0.17);
[4, 10, 18, 23, 27, 33].forEach((t) => whoosh(t, 0.3, 0.045));
kick(33.0, 0.7);

// ── Space: a small stereo echo/room ─────────────────────────────────────────

function room(buf, other, delays, fb, mix) {
  const out = new Float32Array(N);
  for (const d of delays) {
    const D = Math.floor(d * SR);
    const line = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (buf[i] + other[i] * 0.3) * mix + (i >= D ? line[i - D] * fb : 0);
      line[i] = x;
      out[i] += i >= D ? line[i - D] : 0;
    }
  }
  return out;
}
const wetL = room(L, R, [0.0297, 0.0371, 0.0411], 0.55, 0.12);
const wetR = room(R, L, [0.0337, 0.0389, 0.0437], 0.55, 0.12);
const toneL = lp(4000);
const toneR = lp(4000);
for (let i = 0; i < N; i++) {
  L[i] += toneL(wetL[i]);
  R[i] += toneR(wetR[i]);
}

// ── Master: gentle saturation, normalize, tail fade ─────────────────────────

let peak = 0;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * 1.2);
  R[i] = Math.tanh(R[i] * 1.2);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.89 / peak;
const fadeFrom = (DUR - 0.4) * SR;
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + N * 4, 4);
buf.write('WAVEfmt ', 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const f = i > fadeFrom ? 1 - (i - fadeFrom) / (N - fadeFrom) : 1;
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm * f)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm * f)) * 32767), 46 + i * 4);
}
fs.writeFileSync(process.argv[2] ?? 'music.wav', buf);
console.log('peak before norm', peak.toFixed(3));
