// Standalone hub for the desktop app: `npm run server` (listens on 127.0.0.1:8787 by default,
// or on a Unix socket with SMOKE_BREAK_SOCKET). Run it behind a TLS reverse proxy so apps
// connect over wss:// (see docs/hosting.md).

import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createHub, dataFileFromEnv } from './hub.ts';

const port = Number(process.env.PORT) || 8787;
/** Loopback by default: the TLS proxy on the same machine is the only way in. HOST=0.0.0.0 (or an address) to change it. */
const host = process.env.HOST?.trim() || '127.0.0.1';
/** Listen on this Unix socket instead of TCP: only the proxy (owner and group) can open it. */
const socketPath = process.env.SMOKE_BREAK_SOCKET?.trim() || '';
const where = socketPath ? `unix:${socketPath}` : `${host}:${port}`;
const dataFile = dataFileFromEnv();

/**
 * Exit status for "won't start until an admin fixes something": a bad data
 * file, tokens file or setting (EX_CONFIG). A supervisor shouldn't restart on
 * it (systemd: RestartPreventExitStatus=78); restarting changes nothing.
 */
const EXIT_NEEDS_ADMIN = 78;

/**
 * Startup problems end the process with a non-zero status, so a supervisor
 * notices and nothing half-works: EXIT_NEEDS_ADMIN for what only an admin can
 * fix, 1 for what may pass (say, the port is still taken by a hub shutting down).
 */
function die(message: string, status = 1): never {
  console.error(`[smoke-break] !!! ${message}`);
  process.exit(status);
}

let hub: ReturnType<typeof createHub>;
try {
  // Everything createHub refuses is a setting or a file an admin has to fix.
  hub = createHub({ dataFile, unixSocket: !!socketPath, listenHost: socketPath ? undefined : host });
} catch (err) {
  die(`Can't start the hub: ${(err as Error).message}`, EXIT_NEEDS_ADMIN);
}

/**
 * A socket file left behind by a hub that crashed is removed; anything else at
 * that path (a regular file, a socket a live hub is listening on) stops startup.
 */
async function clearStaleSocket(path: string): Promise<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!st.isSocket()) throw new Error(`${path} exists and is not a socket; not touching it.`);
  const live = await new Promise<boolean>((res, rej) => {
    const s = connect(path);
    s.once('connect', () => (s.destroy(), res(true)));
    s.once('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNREFUSED' ? res(false) : rej(err)));
  });
  if (live) throw new Error(`Something is already listening on ${path} (is another hub running?).`);
  unlinkSync(path);
}

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Smoke Break hub. Connect over WebSocket at /ws.\n');
});
server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] === '/ws') hub.handleUpgrade(req, socket, head);
  else socket.destroy();
});
server.on('error', (err: NodeJS.ErrnoException) => {
  hub.close();
  if (err.code === 'EADDRINUSE') die(`${where} is already in use (is another hub running?). Not starting.`);
  if (err.code === 'EACCES') die(`Not allowed to listen on ${where}.`, EXIT_NEEDS_ADMIN);
  die(`The server failed: ${err.message}`);
});

function started() {
  // Only once the hub is up: from here on, a bug in one message shouldn't take breaks down for everyone.
  // Startup errors above are never swallowed. A supervisor should still restart the process if it dies.
  process.on('uncaughtException', (err) => console.error('[smoke-break] !!! uncaught exception (hub kept running):', err));
  process.on('unhandledRejection', (err) => console.error('[smoke-break] !!! unhandled rejection (hub kept running):', err));
  const s = hub.stats();
  const access = s.tokenMode === 'file' ? `per-person tokens (${s.tokenLabels} labels)` : s.tokenMode === 'shared' ? 'shared token' : 'NOT required';
  console.log(`Smoke Break hub on ws://${where}/ws (put it behind TLS for anything but local use)`);
  console.log(
    `[smoke-break] data file: ${dataFile} | access token: ${access}` +
      ` | proxy secret: ${s.proxySecret ? 'required' : 'not set'}` +
      ` | trusted proxies: ${socketPath ? 'the socket' : s.loopbackProxyDefault ? 'loopback (strict mode default)' : process.env.SMOKE_BREAK_TRUST_PROXY?.trim() || 'none'}` +
      ` | public host: ${process.env.SMOKE_BREAK_PUBLIC_HOST || 'not set'}` +
      ` | strict mode: ${s.enterprise ? 'on' : 'off'}`,
  );
  // One line per recommended protection this hub runs without (strict mode refuses to start instead), and for a non-loopback HOST.
  for (const w of s.warnings) console.warn(`[smoke-break] WARNING: ${w}`);
}

if (socketPath) {
  clearStaleSocket(socketPath).then(
    () => {
      // Created 0660 from the start (owner and group: the hub and the proxy), not world-writable for a moment.
      const umask = process.umask(0o117);
      server.listen(socketPath, () => {
        process.umask(umask);
        try {
          chmodSync(socketPath, 0o660);
        } catch (err) {
          hub.close();
          die(`Can't set the permissions of ${socketPath}: ${(err as Error).message}`);
        }
        started();
      });
    },
    (err: Error) => {
      hub.close();
      die(`Can't listen on ${socketPath}: ${err.message}`, /not a socket/.test(err.message) ? EXIT_NEEDS_ADMIN : 1);
    },
  );
} else {
  server.listen(port, host, started);
}

/** Write any pending save and close sockets cleanly, so a restart loses nothing. */
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[smoke-break] ${signal}: saving and shutting down.`);
  hub.close();
  server.close(); // also removes the Unix socket file
  // Give close frames a moment to go out, then exit even if a socket lingers.
  setTimeout(() => process.exit(0), 1000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
