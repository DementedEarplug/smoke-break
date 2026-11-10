// Who may create or join teams: one shared token (SMOKE_BREAK_ACCESS_TOKEN)
// and/or per-person tokens from a file (SMOKE_BREAK_ACCESS_TOKENS_FILE).

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

export interface AccessTokensOptions {
  /** The shared token (SMOKE_BREAK_ACCESS_TOKEN), or ''. */
  shared: string;
  /** Path to the per-person tokens file, or '' for none. */
  file: string;
  /** How often to look for changes to the file. */
  pollMs: number;
  /** Called after a reload with the entries that are now valid. */
  onReload: (valid: (label: string | null, digest: Buffer | null) => boolean) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
}

export class AccessTokens {
  private entries: TokenEntry[];
  private readonly sharedDigest: Buffer | null;
  private readonly opts: AccessTokensOptions;
  private stamp: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Throws if the file is missing, readable by others or malformed: the hub must not start like that. */
  constructor(opts: AccessTokensOptions) {
    this.opts = opts;
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
  }

  /** True when every create/hello must carry a token. */
  get required(): boolean {
    return !!this.sharedDigest || !!this.opts.file;
  }

  get labels(): number {
    return new Set(this.entries.map((e) => e.label)).size;
  }

  /** Who a token belongs to, or null if it isn't valid. Compares against every token in constant time. */
  check(given: unknown): Access | null {
    if (!this.required) return { label: null, digest: null };
    if (typeof given !== 'string' || given.length > 1024) return null;
    const d = digestOf(given);
    let match: TokenEntry | null = null;
    for (const e of this.entries) if (timingSafeEqual(d, e.digest) && !match) match = e;
    const shared = !!this.sharedDigest && timingSafeEqual(d, this.sharedDigest);
    if (match) return { label: match.label, digest: match.digest };
    return shared ? { label: null, digest: this.sharedDigest } : null;
  }

  /** Whether a connection let in with (label, digest) is still allowed after a reload. */
  stillValid(label: string | null, digest: Buffer | null): boolean {
    if (!this.required) return true;
    if (!digest) return false;
    if (label === null) return !!this.sharedDigest && timingSafeEqual(digest, this.sharedDigest);
    return this.entries.some((e) => e.label === label && timingSafeEqual(e.digest, digest));
  }

  private fileStamp(): string {
    try {
      const st = statSync(this.opts.file);
      return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`;
    } catch {
      return 'missing';
    }
  }

  /** Re-reads the file if it changed. A broken file keeps the last good list (and says so) rather than locking everyone out. */
  poll() {
    const stamp = this.fileStamp();
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.reload();
  }

  reload() {
    let next: TokenEntry[];
    try {
      next = readTokensFile(this.opts.file);
    } catch (err) {
      console.error(`[smoke-break] !!! Can't use SMOKE_BREAK_ACCESS_TOKENS_FILE (${(err as Error).message}). Keeping the previous token list.`);
      this.opts.log('tokens-reload-failed', {});
      return;
    }
    const before = new Set(this.entries.map((e) => e.label));
    this.entries = next;
    const after = new Set(next.map((e) => e.label));
    const revoked = [...before].filter((l) => !after.has(l));
    this.opts.log('tokens-reloaded', { labels: after.size, revoked });
    this.opts.onReload((label, digest) => this.stillValid(label, digest));
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
