// Who may connect: one shared token (SMOKE_BREAK_ACCESS_TOKEN) or per-person
// tokens from a file (SMOKE_BREAK_ACCESS_TOKENS_FILE), never both.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/** Names a person or group in logs, bans and quotas. Never the token itself. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
/** Printable ASCII without spaces. */
const TOKEN = /^[\x21-\x7e]{16,512}$/;

export interface TokenEntry {
  label: string;
  digest: Buffer;
}

const digestOf = (token: string) => createHash('sha256').update(token).digest();

/**
 * Parses a tokens file: one `label:token` per line, `#` comments and blank
 * lines allowed. Throws on the first bad line, naming the line but never
 * echoing a token.
 */
export function parseTokensFile(text: string): TokenEntry[] {
  const out: TokenEntry[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = line.indexOf(':');
    const label = at < 0 ? '' : line.slice(0, at).trim();
    const token = at < 0 ? '' : line.slice(at + 1).trim();
    if (!LABEL.test(label)) throw new Error(`line ${i + 1}: expected "label:token" with a label of letters, digits and . _ @ + -`);
    if (!TOKEN.test(token)) throw new Error(`line ${i + 1}: the token for "${label}" must be 16-512 printable characters without spaces`);
    const digest = digestOf(token);
    const hex = digest.toString('hex');
    if (seen.has(hex)) throw new Error(`line ${i + 1}: the token for "${label}" is used on an earlier line too`);
    seen.add(hex);
    out.push({ label, digest });
  });
  return out;
}

/** Reads and checks the file: a regular file nobody but its owner can read or write. */
export function readTokensFile(path: string): TokenEntry[] {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (st.mode & 0o077) {
    throw new Error(`${path} can be read or written by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${path}`);
  }
  return parseTokensFile(readFileSync(path, 'utf8'));
}

export interface Access {
  /** The token file label, or null for the shared token (or an open hub). */
  label: string | null;
  /** Which token was used, so revoking it can close this connection. */
  digest: Buffer | null;
}

/** What the hub learns after the tokens file was read again. */
export interface TokensChange {
  /** Whether a connection let in with (label, digest) may stay. */
  valid: (label: string | null, digest: Buffer | null) => boolean;
  /** Labels in the last good file that aren't in this one (empty while the file is broken). */
  revoked: string[];
  /** Labels in the file now, or null while it's broken (then no token is valid). */
  present: Set<string> | null;
}

export interface AccessTokensOptions {
  /** The shared token (SMOKE_BREAK_ACCESS_TOKEN), or ''. */
  shared: string;
  /** Path to the per-person tokens file, or '' for none. */
  file: string;
  /** How often to look for changes to the file. */
  pollMs: number;
  /** Called after every reload, good or bad. */
  onReload: (change: TokensChange) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
}

export class AccessTokens {
  private entries: TokenEntry[];
  /** The entries by label, so checking every open connection after a reload stays cheap. */
  private byLabel = new Map<string, Buffer[]>();
  private readonly sharedDigest: Buffer | null;
  private readonly opts: AccessTokensOptions;
  private stamp: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Labels in the last file that could be read, to tell what a new one revoked. */
  private lastGood: Set<string>;
  /** Why the file can't be used right now, or null if it's fine. */
  private brokenReason: string | null = null;

  /**
   * Throws if both a shared token and a file are set, or if the file is
   * missing, readable by others or malformed: the hub must not start like that.
   */
  constructor(opts: AccessTokensOptions) {
    this.opts = opts;
    if (opts.shared && opts.file) {
      // A shared token would let anyone in under no label, past every per-person ban and revocation.
      throw new Error(
        'SMOKE_BREAK_ACCESS_TOKENS_FILE and SMOKE_BREAK_ACCESS_TOKEN are both set. Use one: per-person tokens (recommended) or a single shared token, not both.',
      );
    }
    this.sharedDigest = opts.shared ? digestOf(opts.shared) : null;
    this.entries = [];
    this.stamp = '';
    if (opts.file) {
      try {
        this.entries = readTokensFile(opts.file);
      } catch (err) {
        throw new Error(`SMOKE_BREAK_ACCESS_TOKENS_FILE: ${(err as Error).message}`);
      }
      this.stamp = this.fileStamp();
      this.timer = setInterval(() => this.poll(), opts.pollMs);
      this.timer.unref();
    }
    this.lastGood = new Set(this.entries.map((e) => e.label));
    this.setEntries(this.entries);
  }

  private setEntries(entries: TokenEntry[]) {
    this.entries = entries;
    this.byLabel = new Map();
    for (const e of entries) this.byLabel.set(e.label, [...(this.byLabel.get(e.label) ?? []), e.digest]);
  }

  /** True when every connection must carry a token. */
  get required(): boolean {
    return !!this.sharedDigest || !!this.opts.file;
  }

  get labels(): number {
    return new Set(this.entries.map((e) => e.label)).size;
  }

  /** Why the tokens file can't be used right now (no token is valid meanwhile), or null. */
  get broken(): string | null {
    return this.brokenReason;
  }

  /** Labels that are valid now, or null if there is no tokens file or it's broken. */
  present(): Set<string> | null {
    return this.opts.file && !this.brokenReason ? new Set(this.entries.map((e) => e.label)) : null;
  }

  /** Who a token belongs to, or null if it isn't valid. Compares against every token in constant time. */
  check(given: unknown): Access | null {
    if (!this.required) return { label: null, digest: null };
    if (typeof given !== 'string' || given.length > 1024) return null;
    const d = digestOf(given);
    if (this.sharedDigest) return timingSafeEqual(d, this.sharedDigest) ? { label: null, digest: this.sharedDigest } : null;
    let match: TokenEntry | null = null;
    for (const e of this.entries) if (timingSafeEqual(d, e.digest) && !match) match = e;
    return match ? { label: match.label, digest: match.digest } : null;
  }

  /** True if `given` is the very token whose digest is `digest`. */
  sameToken(given: unknown, digest: Buffer | null): boolean {
    if (typeof given !== 'string' || given.length > 1024 || !digest) return false;
    return timingSafeEqual(digestOf(given), digest);
  }

  /** Whether a connection let in with (label, digest) is still allowed. */
  stillValid(label: string | null, digest: Buffer | null): boolean {
    if (!this.required) return true;
    if (!digest) return false;
    if (label === null) return !!this.sharedDigest && timingSafeEqual(digest, this.sharedDigest);
    return (this.byLabel.get(label) ?? []).some((d) => timingSafeEqual(d, digest));
  }

  private fileStamp(): string {
    try {
      const st = statSync(this.opts.file);
      return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`;
    } catch {
      return 'missing';
    }
  }

  /** Re-reads the file if it changed. */
  poll() {
    const stamp = this.fileStamp();
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.reload();
  }

  /**
   * Reads the file again. A file that can't be used fails closed: no token is
   * valid until it's fixed (said once per reason), rather than keeping a list
   * that may still hold a line the admin just deleted.
   */
  reload() {
    if (!this.opts.file) return;
    let next: TokenEntry[];
    try {
      next = readTokensFile(this.opts.file);
    } catch (err) {
      const reason = (err as Error).message;
      this.setEntries([]);
      if (reason !== this.brokenReason) {
        this.brokenReason = reason;
        console.error(
          `[smoke-break] !!! Can't use SMOKE_BREAK_ACCESS_TOKENS_FILE (${reason}). NO access token is valid until it's fixed: ` +
            'new connections are refused and per-person connections are closed. Write the new file next to it and rename it over the old one.',
        );
        this.opts.log('tokens-file-broken', { reason });
      }
      this.opts.onReload({ valid: (l, d) => this.stillValid(l, d), revoked: [], present: null });
      return;
    }
    if (this.brokenReason) console.error('[smoke-break] SMOKE_BREAK_ACCESS_TOKENS_FILE can be used again.');
    this.brokenReason = null;
    this.setEntries(next);
    const after = new Set(next.map((e) => e.label));
    const revoked = [...this.lastGood].filter((l) => !after.has(l));
    this.lastGood = after;
    this.opts.log('tokens-reloaded', { labels: after.size, revoked });
    this.opts.onReload({ valid: (l, d) => this.stillValid(l, d), revoked, present: after });
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
