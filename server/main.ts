// Standalone hub for the desktop app: `npm run server` (PORT defaults to 8787).

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createHub } from './hub.ts';

const port = Number(process.env.PORT) || 8787;
const hub = createHub({ dataFile: resolve(import.meta.dirname, '../.data/teams.json') });

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Smoke Break hub. Connect over WebSocket at /ws.\n');
});
server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] === '/ws') hub.handleUpgrade(req, socket, head);
  else socket.destroy();
});
server.listen(port, () => console.log(`Smoke Break hub on ws://localhost:${port}/ws`));
