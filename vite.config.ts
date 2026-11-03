import { resolve } from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import { createHub } from './server/hub.ts';

// Runs the realtime hub inside the Vite dev/preview server on /ws, so a single
// `npm run dev` (or `npm run share`) is all the prototype needs.
function smokeBreakHub(): Plugin {
  let hub: ReturnType<typeof createHub> | null = null;
  const attach = (httpServer: HttpServer | null | undefined) => {
    if (!httpServer) return;
    hub ??= createHub({ dataFile: resolve(import.meta.dirname, '.data/teams.json') });
    httpServer.on('upgrade', (req, socket, head) => {
      if (req.url?.split('?')[0] === '/ws') hub!.handleUpgrade(req, socket, head);
    });
  };
  return {
    name: 'smoke-break-hub',
    configureServer(server) {
      attach(server.httpServer as HttpServer | null);
    },
    configurePreviewServer(server) {
      attach(server.httpServer as HttpServer);
    },
  };
}

export default defineConfig({
  plugins: [smokeBreakHub()],
  // Fixed port so the desktop app (tauri.conf.json devUrl) can find it.
  server: { port: 5173, strictPort: true },
  // Tauri reads these env vars; keep them out of the way of Vite's own.
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        overlay: resolve(import.meta.dirname, 'overlay.html'),
        panel: resolve(import.meta.dirname, 'panel.html'),
      },
    },
  },
  // `npm run share` serves on the network so teammates (or a tunnel) can reach it.
  preview: { allowedHosts: true },
});
