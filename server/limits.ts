// Small in-memory rate limiters for the hub. Good enough for one process.

/** Keys beyond this are dropped oldest-first, so an address-rotation flood can't grow the map without bound. */
const MAX_KEYS = 50_000;

/** Allows `max` events per `windowMs` for each key (e.g. an IP address). */
export class WindowLimiter {
  /**
   * Kept in order of each key's latest hit (a key is re-inserted when it's hit),
   * so keys that have gone quiet are always at the front and housekeeping only
   * ever looks at the expired ones, never the whole table.
   */
  private hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(max: number, windowMs: number, maxKeys = MAX_KEYS) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  private recent(key: string, now: number): number[] {
    const ts = this.hits.get(key) ?? [];
    let i = 0;
    while (i < ts.length && now - ts[i] >= this.windowMs) i++;
    return i ? ts.slice(i) : ts;
  }

  /** True if the key has used up its limit (without recording anything). */
  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  /** Records an event and returns false if the key is over its limit. */
  take(key: string, now = Date.now()): boolean {
    const recent = this.recent(key, now);
    const ok = recent.length < this.max;
    if (ok) {
      // Move the key to the back: it now has the newest hit.
      recent.push(now);
      this.hits.delete(key);
      this.hits.set(key, recent);
    } else {
      this.hits.set(key, recent); // keeps its place; its newest hit didn't change
    }
    this.sweep(now);
    return ok;
  }

  /** Drops expired keys from the front; stops at the first live one. */
  private sweep(now: number) {
    for (const [k, ts] of this.hits) {
      const expired = !ts.length || now - ts[ts.length - 1] >= this.windowMs;
      if (!expired && this.hits.size <= this.maxKeys) break;
      this.hits.delete(k);
    }
  }

  get size() {
    return this.hits.size;
  }
}

/** Token bucket for one socket: bursts of `capacity`, refilling at `perSecond`. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private readonly capacity: number;
  private readonly perSecond: number;

  constructor(capacity: number, perSecond: number) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
