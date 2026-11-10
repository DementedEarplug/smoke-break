// Standalone hub for the desktop app: `npm run server` (PORT defaults to 8787).
// Run it behind a TLS reverse proxy so apps connect over wss:// (see README).

import { createServer } from 'node:http';
import { createHub, dataFileFromEnv } from './hub.ts';

// Last resort: the hub catches errors per message and per timer, so anything
// that gets here is a bug. Log it loudly rather than letting one bad message
// take breaks down for everyone; a supervisor should still restart the process.
process.on('uncaughtException', (err) => console.error('[smoke-break] !!! uncaught exception (hub kept running):', err));
process.on('unhandledRejection', (err) => console.error('[smoke-break] !!! unhandled rejection (hub kept running):', err));

const port = Number(process.env.PORT) || 8787;
/** e.g. 127.0.0.1 when the TLS proxy runs on the same machine. Default: all interfaces. */
const host = process.env.HOST?.trim() || undefined;
const dataFile = dataFileFromEnv();
const hub = createHub({ dataFile });

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Smoke Break hub. Connect over WebSocket at /ws.\n');
});
server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] === '/ws') hub.handleUpgrade(req, socket, head);
  else socket.destroy();
});
server.listen(port, host, () => {
  console.log(`Smoke Break hub on ws://${host ?? 'localhost'}:${port}/ws (put it behind TLS for anything but local use)`);
  console.log(
    `[smoke-break] data file: ${dataFile} | access token: ${process.env.SMOKE_BREAK_ACCESS_TOKEN?.trim() ? 'required' : 'NOT set'}` +
      ` | trust proxy: ${/^(1|true|yes|on)$/i.test(process.env.SMOKE_BREAK_TRUST_PROXY?.trim() ?? '') ? 'yes' : 'no'} | public host: ${process.env.SMOKE_BREAK_PUBLIC_HOST || 'not set'}`,
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
