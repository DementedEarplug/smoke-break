// Item 4: no client can flood the audit log.

import { describe, expect, it } from 'vitest';
import { createAuditLog } from './audit.ts';
import { hubHarness, sleep } from './hubHarness.ts';

const LIMITS = {
  auditLinesPerSecond: 1000,
  auditBurst: 1000,
  auditPreLinesPerSecond: 1000,
  auditPreBurst: 1000,
  auditPeopleLinesPerSecond: 1000,
  auditPeopleBurst: 1000,
  auditCriticalLinesPerSecond: 1000,
  auditCriticalBurst: 1000,
  auditQueueMax: 1000,
  auditPerKeyPerMinute: 3,
  auditSummaryMs: 60_000,
};

describe('audit log (item 4)', () => {
  it('throttles lines per key and summarizes what it held back', () => {
    const lines: string[] = [];
    const log = createAuditLog((l) => lines.push(l), LIMITS);
    for (let i = 0; i < 100; i++) log.audit('join-failed', { ip: '10.0.0.1', reason: 'bad-code', name: 'x' }, { key: 'jf|bad-code|10.0.0.1' });
    for (let i = 0; i < 2; i++) log.audit('join-failed', { ip: '10.0.0.2', reason: 'bad-code' }, { key: 'jf|bad-code|10.0.0.2' });
    log.audit('create', { ip: '10.0.0.1' });
    expect(lines).toHaveLength(3 + 2 + 1);
    log.summarize();
    const summary = lines.slice(6).map((l) => JSON.parse(l));
    expect(summary).toEqual([{ ts: expect.any(String), event: 'suppressed', of: 'join-failed', ip: '10.0.0.1', reason: 'bad-code', count: 97 }]);
    // Nothing more to say next time.
    log.summarize();
    expect(lines).toHaveLength(7);
    log.close();
  });

  it('puts a ceiling on lines per second across all keys', () => {
    const lines: string[] = [];
    const log = createAuditLog((l) => lines.push(l), { ...LIMITS, auditLinesPerSecond: 1, auditBurst: 10 });
    for (let i = 0; i < 500; i++) log.audit('join', { ip: `10.0.${i >> 8}.${i & 255}` }, { key: `join|${i}` });
    expect(lines).toHaveLength(10);
    log.summarize();
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ event: 'audit-dropped', count: 490 });
    log.close();
  });

  it('caps how many keys the summary spells out', () => {
    const lines: string[] = [];
    const log = createAuditLog((l) => lines.push(l), { ...LIMITS, auditPerKeyPerMinute: 1 });
    for (let i = 0; i < 100; i++) for (let j = 0; j < 3; j++) log.audit('limit', { ip: `ip${i}`, kind: 'x' }, { key: `k${i}` });
    const before = lines.length;
    log.summarize();
    const summary = lines.slice(before).map((l) => JSON.parse(l));
    expect(summary).toHaveLength(21);
    expect(summary.at(-1)).toMatchObject({ of: '*', count: 160 });
  });
});

describe('audit log budgets (review 3, item 1)', () => {
  it('keeps refused upgrades to their own small budget, which nothing else shares', () => {
    const lines: string[] = [];
    const log = createAuditLog((l) => lines.push(l), { ...LIMITS, auditPreBurst: 3, auditPreLinesPerSecond: 0.001, auditBurst: 2, auditLinesPerSecond: 0.001 });
    for (let i = 0; i < 1000; i++) log.audit('limit', { kind: 'unauthorized', ip: `2001:db8:${i}::1` }, { key: `limit|unauthorized|${i}`, perMinute: 1, cls: 'pre' });
    expect(lines).toHaveLength(3);
    // Unlabelled lines have their own budget; labelled ones and critical ones theirs.
    for (let i = 0; i < 5; i++) log.audit('join', { ip: '10.0.0.1' });
    log.audit('join', { ip: '10.0.0.2', label: 'alice' });
    log.audit('approve-member', { ip: '10.0.0.3' }, { cls: 'critical' });
    const events = lines.map((l) => JSON.parse(l).event);
    expect(events.slice(3)).toEqual(['join', 'join', 'join', 'approve-member']);
    log.summarize();
    const summary = lines.slice(7).map((l) => JSON.parse(l));
    expect(summary).toContainEqual(expect.objectContaining({ event: 'audit-dropped', class: 'pre', count: 997, kinds: { unauthorized: 997 } }));
    expect(summary).toContainEqual(expect.objectContaining({ event: 'audit-dropped', class: 'anon', count: 3 }));
    log.close();
  });

  it('queues critical lines over their budget and writes them in order, never dropping them', async () => {
    const lines: string[] = [];
    const log = createAuditLog((l) => lines.push(l), { ...LIMITS, auditCriticalBurst: 2, auditCriticalLinesPerSecond: 50 });
    // Per-key throttles don't apply to them either.
    for (let i = 0; i < 6; i++) log.audit('remove-member', { n: i }, { key: 'same', perMinute: 1, cls: 'critical' });
    expect(lines).toHaveLength(2);
    await sleep(250);
    expect(lines.map((l) => JSON.parse(l).n)).toEqual([0, 1, 2, 3, 4, 5]);
    log.close();
  });

  it('writes what is still queued on close, and counts (loudly) what a full queue could not hold', () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      const log = createAuditLog((l) => lines.push(l), { ...LIMITS, auditCriticalBurst: 1, auditCriticalLinesPerSecond: 0.001, auditQueueMax: 3 });
      for (let i = 0; i < 6; i++) log.audit('transfer-owner', { n: i }, { cls: 'critical' });
      expect(lines).toHaveLength(1);
      log.close();
    } finally {
      console.error = orig;
    }
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.filter((l) => l.event === 'transfer-owner').map((l) => l.n)).toEqual([0, 1, 2, 3]);
    expect(parsed.at(-1)).toMatchObject({ event: 'audit-dropped', class: 'critical', count: 2 });
    expect(errors.join('\n')).toMatch(/critical audit line\(s\) were lost/);
  });
});

describe('audit log on the hub (item 4)', () => {
  const h = hubHarness();

  it('a client hammering bad hellos writes a handful of lines, not thousands', async () => {
    h.start({ limits: { badCodeDelayMs: 0, connectionsPerIp: 10_000, unidentifiedPerIp: 10_000, maxUnidentified: 10_000 } });
    const runs = Array.from({ length: 400 }, async (_, i) => {
      const c = await h.connect();
      c.send(i % 2 ? { type: 'hello', clientId: 'x', name: 'A'.repeat(24) } : { type: 'hello', clientId: 'valid-client-id-000000', teamCode: 'NOPE' });
      await c.closed;
    });
    await Promise.all(runs);
    const before = h.logs.length;
    // At most auditPerKeyPerMinute (5) per reason: invalid-client-id, bad-code, locked-out, plus a limit line.
    expect(before).toBeLessThanOrEqual(16);
    h.hub.summarizeAudit();
    const summary = h.logs.slice(before).map((l) => JSON.parse(l));
    const held = summary.filter((l) => l.event === 'suppressed').reduce((n, l) => n + l.count, 0);
    // Everything is accounted for: written or counted.
    const written = h.logs.slice(0, before).filter((l) => l.includes('join-failed')).length;
    expect(written + held).toBeGreaterThanOrEqual(400);
    // Names a stranger picked don't end up in the summary.
    expect(h.logs.join('\n')).not.toContain('A'.repeat(24));
  });

  it('throttles rejected upgrades too', async () => {
    for (let i = 0; i < 50; i++) await h.connect({ origin: 'https://evil.example' }).catch(() => {});
    await sleep(50);
    expect(h.logs.filter((l) => l.includes('"origin"')).length).toBe(1);
  });
});
