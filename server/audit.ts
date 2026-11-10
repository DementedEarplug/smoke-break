// The hub's audit log: one JSON line per security-relevant event, with a
// ceiling on how fast lines can be written so no client can fill the disk.
//
// Lines come in four classes, each with its own budget, so nobody can crowd
// out lines that matter by causing lots of others:
//
// - `pre`: upgrades refused before anyone is authenticated (no or wrong token,
//   wrong origin or host, missing proxy secret). Anyone who can reach the hub
//   can cause these, so they share one small hub-wide budget; the rest are
//   counted by kind in the periodic summary.
// - `anon`: everything else from connections without a token label (a shared
//   token, or an open hub).
// - `people`: lines caused by someone with a token label, and owners' actions.
//   Nothing in the other classes can use this budget.
// - `critical`: removals, ownership changes, code replacements, approvals and
//   denials, revoked tokens, and the hub's own events. Never dropped: over
//   their budget they wait in a (bounded) queue and are written in order as
//   the budget refills.

import { TokenBucket, WindowLimiter } from './limits.ts';

export interface AuditLimits {
  /** `anon` lines per second (after a burst of `auditBurst`). Beyond that, lines are counted, not written. */
  auditLinesPerSecond: number;
  auditBurst: number;
  /** `pre` lines (refused upgrades) per second across the hub, after a burst of `auditPreBurst`. */
  auditPreLinesPerSecond: number;
  auditPreBurst: number;
  /** `people` lines per second, after a burst of `auditPeopleBurst`. */
  auditPeopleLinesPerSecond: number;
  auditPeopleBurst: number;
  /** `critical` lines per second, after a burst of `auditCriticalBurst`; beyond that they're queued. */
  auditCriticalLinesPerSecond: number;
  auditCriticalBurst: number;
  /** Most critical lines waiting to be written. */
  auditQueueMax: number;
  /** Throttled lines (failed joins, limit hits): at most this many per minute for each reason and address. */
  auditPerKeyPerMinute: number;
  /** How often to write the "N more suppressed" summary. */
  auditSummaryMs: number;
}

export type AuditClass = 'pre' | 'anon' | 'people' | 'critical';

/** Most distinct suppressed keys remembered between summaries; the rest are only counted. */
const MAX_SUPPRESSED_KEYS = 1000;
/** Most per-key summary lines per summary; the rest go into one total. */
const MAX_SUMMARY_LINES = 20;
/** Most distinct kinds counted for the `pre` summary. */
const MAX_PRE_KINDS = 50;

export interface Throttle {
  /** e.g. `join-failed|bad-code|10.0.0.1`. Lines with the same key share a budget. Critical lines ignore it. */
  key?: string;
  /** Lines per minute for this key (default: auditPerKeyPerMinute). */
  perMinute?: number;
  /** Which budget the line counts against. Default: `people` if it carries a label, else `anon`. */
  cls?: AuditClass;
}

export interface AuditLog {
  /**
   * Writes one line. Never pass codes, tokens, clientIds or meeting links.
   * Lines a stranger or a failing client can cause must pass a throttle key.
   */
  audit(event: string, fields?: Record<string, unknown>, throttle?: Throttle): void;
  /** Writes the suppressed/dropped summary now (if there is anything to report). */
  summarize(): void;
  /** Writes every queued critical line now, then the summary. */
  close(): void;
}

export function createAuditLog(write: (line: string) => void, limits: AuditLimits, now: () => number = Date.now): AuditLog {
  const buckets: Record<Exclude<AuditClass, 'critical'>, TokenBucket> = {
    pre: new TokenBucket(limits.auditPreBurst, limits.auditPreLinesPerSecond),
    anon: new TokenBucket(limits.auditBurst, limits.auditLinesPerSecond),
    people: new TokenBucket(limits.auditPeopleBurst, limits.auditPeopleLinesPerSecond),
  };
  const critical = new TokenBucket(limits.auditCriticalBurst, limits.auditCriticalLinesPerSecond);
  /** Critical lines over their budget, already stamped, oldest first. */
  const queue: string[] = [];
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  const perKey = new Map<number, WindowLimiter>();
  /** key → what was suppressed, for the summary. */
  const suppressed = new Map<string, { fields: Record<string, unknown>; count: number }>();
  let suppressedOther = 0;
  const dropped = { pre: 0, anon: 0, people: 0, critical: 0 };
  /** Refused upgrades over the `pre` budget, by kind. */
  const preKinds = new Map<string, number>();
  let closed = false;

  function line(event: string, fields: Record<string, unknown>): string | null {
    try {
      return JSON.stringify({ ts: new Date(now()).toISOString(), event, ...fields });
    } catch {
      return null;
    }
  }
  function out(text: string | null) {
    if (text === null) return;
    try {
      write(text);
    } catch {
      // Logging must never take the hub down.
    }
  }
  const emit = (event: string, fields: Record<string, unknown>) => out(line(event, fields));

  /** Writes queued critical lines while the budget allows; comes back when it has refilled. */
  function drain() {
    drainTimer = null;
    while (queue.length && critical.take(now())) out(queue.shift()!);
    if (queue.length && !closed) {
      drainTimer = setTimeout(drain, Math.max(10, Math.ceil(1000 / limits.auditCriticalLinesPerSecond)));
      drainTimer.unref();
    }
  }

  function audit(event: string, fields: Record<string, unknown> = {}, throttle: Throttle = {}) {
    const cls: AuditClass = throttle.cls ?? (fields.label ? 'people' : 'anon');
    if (cls === 'critical') {
      // In order: nothing jumps the queue.
      if (!queue.length && critical.take(now())) return emit(event, fields);
      if (queue.length >= limits.auditQueueMax) {
        dropped.critical++;
        return;
      }
      const text = line(event, fields);
      if (text !== null) queue.push(text);
      if (!drainTimer && !closed) drain();
      return;
    }
    if (throttle.key !== undefined) {
      const max = throttle.perMinute ?? limits.auditPerKeyPerMinute;
      let limiter = perKey.get(max);
      if (!limiter) perKey.set(max, (limiter = new WindowLimiter(max, 60_000)));
      if (!limiter.take(throttle.key, now())) {
        const s = suppressed.get(throttle.key);
        if (s) s.count++;
        else if (suppressed.size < MAX_SUPPRESSED_KEYS) {
          // Only the fields that say what and where; never anything a client chose freely, like a name.
          const { ip, reason, kind, label } = fields;
          suppressed.set(throttle.key, { fields: { of: event, ip, reason, kind, label }, count: 1 });
        } else suppressedOther++;
        return;
      }
    }
    if (!buckets[cls].take(now())) {
      dropped[cls]++;
      if (cls === 'pre') {
        const kind = typeof fields.kind === 'string' ? fields.kind : event;
        if (preKinds.has(kind) || preKinds.size < MAX_PRE_KINDS) preKinds.set(kind, (preKinds.get(kind) ?? 0) + 1);
      }
      return;
    }
    emit(event, fields);
  }

  /** Summary lines bypass the budgets: there are at most MAX_SUMMARY_LINES + 5 per interval. */
  function summarize() {
    let lines = 0;
    let rest = suppressedOther;
    for (const { fields, count } of suppressed.values()) {
      if (lines++ < MAX_SUMMARY_LINES) emit('suppressed', { ...fields, count });
      else rest += count;
    }
    if (rest) emit('suppressed', { of: '*', count: rest });
    if (dropped.pre) emit('audit-dropped', { class: 'pre', count: dropped.pre, kinds: Object.fromEntries(preKinds), reason: 'refused upgrades over their budget' });
    if (dropped.anon) emit('audit-dropped', { class: 'anon', count: dropped.anon, reason: 'over the log ceiling' });
    if (dropped.people) emit('audit-dropped', { class: 'people', count: dropped.people, reason: 'over the log ceiling' });
    if (dropped.critical) {
      emit('audit-dropped', { class: 'critical', count: dropped.critical, reason: 'critical queue full' });
      console.error(`[smoke-break] !!! ${dropped.critical} critical audit line(s) were lost: the queue of ${limits.auditQueueMax} was full.`);
    }
    if (queue.length) emit('audit-queued', { count: queue.length, reason: 'critical lines waiting for the log budget' });
    suppressed.clear();
    suppressedOther = 0;
    dropped.pre = dropped.anon = dropped.people = dropped.critical = 0;
    preKinds.clear();
  }

  const timer = setInterval(summarize, limits.auditSummaryMs);
  timer.unref();

  return {
    audit,
    summarize,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = null;
      // Shutting down: what's queued is written now rather than lost.
      for (const text of queue.splice(0)) out(text);
      summarize();
    },
  };
}
