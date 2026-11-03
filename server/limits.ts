// Small in-memory rate limiters for the hub. Good enough for one process.

/** Allows `max` events per `windowMs` for each key (e.g. an IP address). */
export class WindowLimiter {
  private hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Records an event and returns false if the key is over its limit. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const ok = recent.length < this.max;
    if (ok) recent.push(now);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    // Forget idle keys now and then so the map can't grow without bound.
    if (this.hits.size > 10_000) {
      for (const [k, ts] of this.hits) if (now - ts[ts.length - 1] >= this.windowMs) this.hits.delete(k);
    }
    return ok;
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
