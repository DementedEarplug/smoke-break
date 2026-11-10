// Standalone hub for the desktop app: `npm run server` (listens on 127.0.0.1:8787 by default).
// Run it behind a TLS reverse proxy so apps connect over wss:// (see README).

import { createServer } from 'node:http';
import { createHub, dataFileFromEnv } from './hub.ts';

const port = Number(process.env.PORT) || 8787;
/** Loopback by default: the TLS proxy on the same machine is the only way in. HOST=0.0.0.0 (or an address) to change it. */
const host = process.env.HOST?.trim() || '127.0.0.1';
const dataFile = dataFileFromEnv();

/** Startup problems end the process with a non-zero status, so a supervisor notices and nothing half-works. */
function die(message: string): never {
  console.error(`[smoke-break] !!! ${message}`);
  process.exit(1);
}

let hub: ReturnType<typeof createHub>;
try {
  hub = createHub({ dataFile });
} catch (err) {
  die(`Can't start the hub: ${(err as Error).message}`);
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
  if (err.code === 'EADDRINUSE') die(`${host}:${port} is already in use (is another hub running?). Not starting.`);
  if (err.code === 'EACCES') die(`Not allowed to listen on ${host}:${port}.`);
  die(`The server failed: ${err.message}`);
});
server.listen(port, host, () => {
  // Only once the hub is up: from here on, a bug in one message shouldn't take breaks down for everyone.
  // Startup errors above are never swallowed. A supervisor should still restart the process if it dies.
  process.on('uncaughtException', (err) => console.error('[smoke-break] !!! uncaught exception (hub kept running):', err));
  process.on('unhandledRejection', (err) => console.error('[smoke-break] !!! unhandled rejection (hub kept running):', err));
  const s = hub.stats();
  const access = s.tokenLabels ? `per-person tokens (${s.tokenLabels} labels)` : s.tokensRequired ? 'shared token' : 'NOT required';
  console.log(`Smoke Break hub on ws://${host}:${port}/ws (put it behind TLS for anything but local use)`);
  console.log(
    `[smoke-break] data file: ${dataFile} | access token: ${access}` +
      ` | trusted proxies: ${process.env.SMOKE_BREAK_TRUST_PROXY?.trim() || 'none'} | public host: ${process.env.SMOKE_BREAK_PUBLIC_HOST || 'not set'}`,
  );
});

/** Write any pending save and close sockets cleanly, so a restart loses nothing. */
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[smoke-break] ${signal}: saving and shutting down.`);
  hub.close();
  server.close();
  // Give close frames a moment to go out, then exit even if a socket lingers.
  setTimeout(() => process.exit(0), 1000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
