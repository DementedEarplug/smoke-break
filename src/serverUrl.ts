// Which hub addresses the app is willing to talk to. Kept free of DOM and
// storage so it can be unit tested.

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Over plain ws:// the client id (the only proof of who you are), invite codes
 * and the meeting link travel in clear, so the app only talks to a hub over
 * wss://. Plain ws:// is fine to this machine, for development.
 * Returns the address to connect to, or a message saying what's wrong.
 */
export function checkServerUrl(raw: string): { url: string } | { error: string } {
  const s = raw.trim();
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { error: 'The server address should look like wss://breaks.example.com/ws.' };
  }
  if (/[\s\\]/.test(s) || url.username || url.password) {
    return { error: 'The server address should look like wss://breaks.example.com/ws.' };
  }
  if (url.protocol === 'wss:') return { url: url.href };
  if (url.protocol === 'ws:') {
    if (LOOPBACK_HOSTS.includes(url.hostname)) return { url: url.href };
    return { error: 'The server address must start with wss:// (encrypted). Plain ws:// only works for localhost.' };
  }
  return { error: 'The server address must start with wss://.' };
}

