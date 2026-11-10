// Item 4: no client can flood the audit log.

import { describe, expect, it } from 'vitest';
import { createAuditLog } from './audit.ts';
import { hubHarness, sleep } from './hubHarness.ts';

const LIMITS = { auditLinesPerSecond: 1000, auditBurst: 1000, auditPerKeyPerMinute: 3, auditSummaryMs: 60_000 };

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
