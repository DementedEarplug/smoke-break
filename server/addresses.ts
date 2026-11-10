// Client addresses (behind trusted proxies only), per-address keys, and the Host/Origin checks.

import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

/** IPv4-mapped IPv6 addresses (::ffff:1.2.3.4) count as the IPv4 address. */
function plainIp(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

/** The proxies whose X-Forwarded-For is believed; null means none. */
export type TrustedProxies = BlockList | null;

const LOOPBACK_WORDS = /^(1|true|yes|on)$/i;
const OFF_WORDS = /^(|0|false|no|off)$/i;

/**
 * Parses SMOKE_BREAK_TRUST_PROXY: comma-separated IPs and CIDR ranges of the
 * reverse proxies in front of the hub. `1`/`true` means loopback only (a proxy
 * on the same machine). Anything that isn't an address or range is an error,
 * so a typo can't silently trust (or distrust) the wrong peers.
 */
export function parseTrustedProxies(v: string | boolean | readonly string[] | undefined): TrustedProxies {
  if (v === undefined || v === false) return null;
  const list = new BlockList();
  if (v === true) return loopback(list);
  const entries = typeof v === 'string' ? v.split(',').map((s) => s.trim()) : v.map((s) => s.trim());
  if (entries.length === 1 && OFF_WORDS.test(entries[0])) return null;
  if (entries.length === 1 && LOOPBACK_WORDS.test(entries[0])) return loopback(list);
  for (const entry of entries.filter(Boolean)) {
    const [addr, prefix, extra] = entry.split('/');
    const ip = plainIp(addr ?? '');
    const kind = isIP(ip);
    const bits = prefix === undefined ? null : Number(prefix);
    const max = kind === 4 ? 32 : 128;
    if (!kind || extra !== undefined || (bits !== null && (!/^\d{1,3}$/.test(prefix!) || bits > max))) {
      throw new Error(`SMOKE_BREAK_TRUST_PROXY: "${entry}" is not an IP address or CIDR range (e.g. 10.0.0.5 or 10.0.0.0/24).`);
    }
    const type = kind === 4 ? 'ipv4' : 'ipv6';
    if (bits === null) list.addAddress(ip, type);
    else list.addSubnet(ip, bits, type);
  }
  return list;
}

function loopback(list: BlockList): BlockList {
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addAddress('::1', 'ipv6');
  return list;
}

export function isTrustedProxy(trusted: TrustedProxies, ip: string): boolean {
  if (!trusted) return false;
  const p = plainIp(ip);
  const kind = isIP(p);
  return kind !== 0 && trusted.check(p, kind === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The client's address. X-Forwarded-For is only believed when the TCP peer is
 * one of the trusted proxies; then the right-most entry that isn't itself a
 * trusted proxy is the client (so a CDN → nginx chain works when both are
 * listed). Anything left of that was written by the client and is ignored.
 * `socketPeerIsProxy`: the hub listens on a Unix socket only the proxy can
 * open, so a peer without an IP address is the proxy.
 */
export function clientAddress(req: IncomingMessage, trusted: TrustedProxies, socketPeerIsProxy = false): string {
  const remote = req.socket.remoteAddress;
  const peer = plainIp(remote ?? 'unix');
  if (!(socketPeerIsProxy && remote === undefined) && !isTrustedProxy(trusted, peer)) return peer;
  const header = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  let client = peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = plainIp(hops[i]);
    if (!isIP(hop)) break; // A malformed hop: don't believe anything further left.
    client = hop;
    if (!isTrustedProxy(trusted, hop)) break;
  }
  return client;
}

/**
 * The key per-address limits use. One machine usually gets a whole IPv6 /64,
 * so IPv6 addresses are grouped by it (or, with `v6Bits` 56, by the /56 a
 * home or small office is usually given); IPv4-mapped addresses count as IPv4.
 */
export function addressKey(ip: string, v6Bits: 64 | 56 = 64): string {
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) return ip.slice(7);
  const bare = ip.split('%')[0];
  if (isIP(bare) !== 6) return ip;
  const halves = bare.split('::');
  const groups = (s: string | undefined) => (s ? s.split(':') : []);
  const width = (g: string[]) => g.reduce((n, x) => n + (x.includes('.') ? 2 : 1), 0);
  const left = groups(halves[0]);
  const right = groups(halves[1]);
  const full = halves.length === 2 ? [...left, ...Array(8 - width(left) - width(right)).fill('0'), ...right] : left;
  const head = full.slice(0, 4).map((g) => parseInt(g, 16));
  if (v6Bits === 56) head[3] &= 0xff00;
  return `${head.map((g) => g.toString(16)).join(':')}::/${v6Bits}`;
}

/** The desktop app's own origins (macOS/Linux, Windows). */
const APP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export interface OriginPolicy {
  publicHosts?: string[];
  allowedOrigins?: string[];
  allowLocalhostPages?: boolean;
}

function parseHost(host: string | undefined): URL | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`);
  } catch {
    return null;
  }
}

const hostListed = (u: URL, p: OriginPolicy) =>
  (p.publicHosts ?? []).some((h) => h.toLowerCase() === u.hostname || h.toLowerCase() === u.host) ||
  (!!p.allowLocalhostPages && LOCAL_HOSTNAMES.includes(u.hostname));

/**
 * With SMOKE_BREAK_PUBLIC_HOST set, the request's Host must be one of those
 * names, so a DNS-rebound name pointing at the hub is turned away.
 */
export function isAllowedHost(host: string | undefined, policy: OriginPolicy): boolean {
  if (!policy.publicHosts?.length) return true;
  const u = parseHost(host);
  return !!u && hostListed(u, policy);
}

/**
 * Browsers send an Origin with every WebSocket, so this stops other web pages
 * from driving the hub. Allowed: the desktop app, SMOKE_BREAK_ALLOWED_ORIGINS,
 * and pages served from the same host only when that host is a configured
 * public host (or localhost, for the dev server). "Same host as the request"
 * alone isn't enough: DNS rebinding makes any page match it. Non-browser
 * clients send no Origin and are let through.
 */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined, policy: OriginPolicy = {}): boolean {
  if (origin === undefined) return true;
  if (APP_ORIGINS.includes(origin) || (policy.allowedOrigins ?? []).includes(origin)) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const h = parseHost(host);
  return !!h && o.host === h.host && hostListed(o, policy);
}
