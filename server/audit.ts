// The hub's audit log: one JSON line per security-relevant event, with a
// ceiling on how fast lines can be written so no client can fill the disk.

import { TokenBucket, WindowLimiter } from './limits.ts';

export interface AuditLimits {
  /** Lines per second across the whole log (after a burst of `auditBurst`). Beyond that, lines are counted, not written. */
  auditLinesPerSecond: number;
  auditBurst: number;
  /** Throttled lines (failed joins, limit hits): at most this many per minute for each reason and address. */
  auditPerKeyPerMinute: number;
  /** How often to write the "N more suppressed" summary. */
  auditSummaryMs: number;
}

/** Most distinct suppressed keys remembered between summaries; the rest are only counted. */
const MAX_SUPPRESSED_KEYS = 1000;
/** Most per-key summary lines per summary; the rest go into one total. */
const MAX_SUMMARY_LINES = 20;

export interface Throttle {
  /** e.g. `join-failed|bad-code|10.0.0.1`. Lines with the same key share a budget. */
  key: string;
  /** Lines per minute for this key (default: auditPerKeyPerMinute). */
  perMinute?: number;
}

export interface AuditLog {
  /**
   * Writes one line. Never pass codes, tokens, clientIds or meeting links.
   * Lines a stranger or a failing client can cause must pass `throttle`.
   */
  audit(event: string, fields?: Record<string, unknown>, throttle?: Throttle): void;
  /** Writes the suppressed/dropped summary now (if there is anything to report). */
  summarize(): void;
  close(): void;
}

export function createAuditLog(write: (line: string) => void, limits: AuditLimits, now: () => number = Date.now): AuditLog {
  const bucket = new TokenBucket(limits.auditBurst, limits.auditLinesPerSecond);
  const perKey = new Map<number, WindowLimiter>();
  /** key → what was suppressed, for the summary. */
  const suppressed = new Map<string, { fields: Record<string, unknown>; count: number }>();
  let suppressedOther = 0;
  let dropped = 0;

  function emit(event: string, fields: Record<string, unknown>) {
    try {
      write(JSON.stringify({ ts: new Date(now()).toISOString(), event, ...fields }));
    } catch {
      // Logging must never take the hub down.
    }
  }

  function audit(event: string, fields: Record<string, unknown> = {}, throttle?: Throttle) {
    if (throttle) {
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
    if (!bucket.take(now())) {
      dropped++;
      return;
    }
    emit(event, fields);
  }

  /** Summary lines bypass the ceiling: there are at most MAX_SUMMARY_LINES + 2 per interval. */
  function summarize() {
    let lines = 0;
    let rest = suppressedOther;
    for (const { fields, count } of suppressed.values()) {
      if (lines++ < MAX_SUMMARY_LINES) emit('suppressed', { ...fields, count });
      else rest += count;
    }
    if (rest) emit('suppressed', { of: '*', count: rest });
    if (dropped) emit('audit-dropped', { count: dropped, reason: 'over the log ceiling' });
    suppressed.clear();
    suppressedOther = 0;
    dropped = 0;
  }

  const timer = setInterval(summarize, limits.auditSummaryMs);
  timer.unref();

  return {
    audit,
    summarize,
    close() {
      clearInterval(timer);
      summarize();
    },
  };
}
