// Item 1: one member (or one address) must not be able to stall the hub by forcing rebroadcasts.

import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ALEX, type Client, SAM, hubHarness, sleep } from './hubHarness.ts';

const h = hubHarness();

/** Frames a client got since `from`. */
const since = (c: Client, from: number) => c.msgs.slice(from);

describe('no-op messages send nothing (item 1)', () => {
  it('ignores leave/join/light/setLength/settings that change nothing', async () => {
    const { alex, sam } = await h.team();
    await sleep(100);
    const a0 = alex.msgs.length;
    const s0 = sam.msgs.length;
    for (let i = 0; i < 5; i++) {
      sam.send({ type: 'leave' }); // not in a break
      alex.send({ type: 'settings' }); // nothing to change
      alex.send({ type: 'settings', teamName: 'Crew', defaultLengthMin: 12, requireApproval: false });
    }
    await sleep(200);
    expect(since(alex, a0)).toEqual([]);
    expect(since(sam, s0)).toEqual([]);

    alex.send({ type: 'invite' });
    await sam.state((m) => m.team.brk?.phase === 'pending', s0);
    sam.send({ type: 'join' });
    await alex.state((m) => m.team.brk?.participants.length === 2, a0);
    await sleep(100);
    const a1 = alex.msgs.length;
    const s1 = sam.msgs.length;
    for (let i = 0; i < 5; i++) {
      sam.send({ type: 'join' }); // already in
      alex.send({ type: 'invite' }); // joins the running break: already in
    }
    await sleep(200);
    expect(since(alex, a1)).toEqual([]);
    expect(since(sam, s1)).toEqual([]);
  });

  it("doesn't tell the team when one more of your sockets connects, only the new socket", async () => {
    const { alex, sam, code } = await h.team();
    await sleep(100);
    const s0 = sam.msgs.length;
    const { msg } = await h.hello(code, ALEX, 'Alex');
    expect(msg.type).toBe('state');
    await sleep(100);
    expect(since(sam, s0)).toEqual([]);
    expect(alex.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('broadcast coalescing (item 1)', () => {
  it('sends at most one state per interval per team, and always the last one', async () => {
    h.start({ limits: { broadcastIntervalMs: 200, messageBurst: 1e9, messagesPerSecond: 1e9, joinLeavePerWindow: 1e9 } });
    const { alex, sam } = await h.team();
    await sleep(300);
    const s0 = sam.msgs.length;
    const started = Date.now();
    for (let i = 1; i <= 50; i++) {
      alex.send({ type: 'settings', teamName: `Crew ${i}` });
      if (i % 10 === 0) await sleep(50);
    }
    const last = await sam.state((m) => m.team.name === 'Crew 50', s0);
    const frames = since(sam, s0);
    const elapsed = Date.now() - started;
    expect(last.team.name).toBe('Crew 50');
    // ~250 ms of changes, 200 ms apart: a handful of frames, not 50.
    expect(frames.length).toBeLessThanOrEqual(Math.ceil(elapsed / 200) + 1);
    expect(frames.length).toBeLessThan(6);
  });
});

describe('sockets per member (item 1)', () => {
  it('closes your oldest socket when you open more than the cap', async () => {
    h.start({ limits: { maxSocketsPerMember: 2 } });
    const { alex, sam, code } = await h.team();
    const extra1 = (await h.hello(code, SAM, 'Sam')).c;
    expect(sam.ws.readyState).toBe(WebSocket.OPEN);
    const extra2 = (await h.hello(code, SAM, 'Sam')).c;
    // Sam's first socket was the oldest: closed, with a "keep the team, try later" code.
    expect(await sam.fatal()).toMatchObject({ code: 'rate-limited' });
    await sam.closed;
    expect(extra1.ws.readyState).toBe(WebSocket.OPEN);
    expect(extra2.ws.readyState).toBe(WebSocket.OPEN);
    // Sam is still online, through the newer two.
    await sleep(100);
    expect(alex.lastState().team.members.find((m) => m.name === 'Sam')!.online).toBe(true);
    expect(h.logs.some((l) => l.includes('sockets-per-member'))).toBe(true);
  });

  it('a member with many sockets gets no more than the cap of them', async () => {
    h.start({ limits: { maxSocketsPerMember: 4 } });
    const { code } = await h.team();
    const socks = [];
    for (let i = 0; i < 12; i++) socks.push((await h.hello(code, ALEX, 'Alex')).c);
    await sleep(200);
    expect(socks.filter((c) => c.ws.readyState === WebSocket.OPEN)).toHaveLength(4);
  });
});

describe('per-address message budget (item 1)', () => {
  it('shares one budget across all of an address’s sockets', async () => {
    h.start({ limits: { addressMessageBurst: 20, addressMessagesPerSecond: 1, maxSocketsPerMember: 10 } });
    const { alex, code } = await h.team();
    const socks = [alex];
    for (let i = 0; i < 4; i++) socks.push((await h.hello(code, ALEX, 'Alex')).c);
    await sleep(1100);
    // Each socket's own bucket would allow 30; together they get the address's ~20.
    const from = socks.map((c) => c.msgs.length);
    for (const c of socks) for (let i = 0; i < 10; i++) c.send({ type: 'light' }); // "There is no break to light."
    await sleep(300);
    const answered = socks.reduce((n, c, i) => n + c.msgs.slice(from[i]).filter((m) => m.type === 'error').length, 0);
    // 50 sent, each socket within its own limit: without the shared budget all 50 would be answered.
    // (Setting up the team already spent part of it.)
    expect(answered).toBeGreaterThan(0);
    expect(answered).toBeLessThanOrEqual(22);
  });
});

describe('hub-wide buffer cap (item 1)', () => {
  it('drops the sockets holding the most when the total gets too big', async () => {
    h.start({
      limits: {
        maxBufferedBytes: 10 * 1024 * 1024,
        maxTotalBufferedBytes: 64 * 1024,
        bufferCheckMs: 20,
        // Owners' settings changes are limited too; this is about what comes after.
        joinLeavePerWindow: 1e9,
        broadcastIntervalMs: 0,
        messageBurst: 1e9,
        messagesPerSecond: 1e9,
        addressMessageBurst: 1e9,
        addressMessagesPerSecond: 1e9,
        auditBurst: 1e9,
        auditLinesPerSecond: 1e9,
      },
    });
    const { alex, sam, code } = await h.team();
    for (let i = 0; i < 40; i++) (await h.hello(code, `filler-client-id-${String(i).padStart(4, '0')}`, `Filler ${i} ${'y'.repeat(12)}`)).c.ws.close();
    (sam.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    for (let i = 0; i < 3000 && sam.ws.readyState === WebSocket.OPEN; i++) {
      alex.send({ type: 'settings', teamName: `Crew ${i} ${'x'.repeat(10)}` });
      await sleep(1);
      if (h.logs.some((l) => l.includes('send-buffer-total'))) break;
    }
    expect(h.logs.some((l) => l.includes('"send-buffer-total"'))).toBe(true);
    // The reader that kept up is still there.
    expect(alex.ws.readyState).toBe(WebSocket.OPEN);
  });
});
