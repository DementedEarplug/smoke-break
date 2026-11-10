import { resolve } from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { type Connect, defineConfig, type Plugin } from 'vite';
import { createHub, dataFileFromEnv } from './server/hub.ts';

const dataFile = dataFileFromEnv();

/** Sent with every dev and preview response: no framing by other pages, no content sniffing. */
const SECURITY_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};

// Runs the realtime hub inside the Vite dev/preview server on /ws, so a single
// `npm run dev` (or `npm run share`) is all the prototype needs. This is for
// development and quick tests only; real deployments use `npm run server`.
function smokeBreakHub(): Plugin {
  let hub: ReturnType<typeof createHub> | null = null;
  const attach = (httpServer: HttpServer | null | undefined) => {
    if (!httpServer) return;
    // Pages here are served by this same server, so localhost pages may connect (only localhost: see isAllowedOrigin).
    hub ??= createHub({ dataFile, allowLocalhostPages: true });
    httpServer.on('upgrade', (req, socket, head) => {
      if (req.url?.split('?')[0] === '/ws') hub!.handleUpgrade(req, socket, head);
    });
    httpServer.once('close', () => hub?.close());
  };
  // Vite's `headers` options don't reach every response (e.g. some errors), so set them first thing.
  const headers = (server: { middlewares: Connect.Server }) =>
    server.middlewares.use((_req, res, next) => {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      next();
    });
  return {
    name: 'smoke-break-hub',
    configureServer(server) {
      headers(server);
      attach(server.httpServer as HttpServer | null);
    },
    configurePreviewServer(server) {
      headers(server);
      attach(server.httpServer as HttpServer);
    },
  };
}

export default defineConfig({
  plugins: [smokeBreakHub()],
  server: {
    // Fixed port so the desktop app (tauri.conf.json devUrl) can find it.
    port: 5173,
    strictPort: true,
    headers: SECURITY_HEADERS,
    fs: {
      // The team file holds every invite code and Zoom link: never serve it.
      // Setting `deny` replaces Vite's defaults, so they're repeated here.
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '**/.data/**',
        // Wherever SMOKE_BREAK_DATA_DIR puts it, plus its temp, backup and .corrupt-* copies.
        `${dataFile}*`,
        // Security reviews describe weaknesses; nobody browsing the dev server needs them.
        '*audit*.md',
        '*AUDIT*.md',
        '**/AUDIT.md',
        '**/SECURITY-AUDIT.md',
      ],
    },
  },
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
  // `npm run share` serves on the network for a quick test with teammates. Not a deployment.
  preview: { allowedHosts: true, headers: SECURITY_HEADERS },
});
