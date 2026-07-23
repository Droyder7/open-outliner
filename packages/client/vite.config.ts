import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Service worker (offline-and-pwa.md): precache the app shell so the PWA
// cold-starts offline, plus light runtime caching for static assets. The SW
// intentionally does NOT touch `/rpc` or the Hocuspocus WebSocket — mutating
// `/rpc` calls are replayed by the app-level durable outbox
// (`src/offline/outbox.ts`), not Background Sync (see that file for why),
// and a service worker only ever sees `fetch` events, never WS frames, so
// the CRDT transport is untouched by construction.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // autoUpdate is safe here: the mutation outbox and the Yjs
      // `y-indexeddb` store both live in IndexedDB, not Cache Storage, so an
      // SW activating a new version never touches — let alone drops — a
      // pending write (offline-and-pwa.md "service-worker upgrade").
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
      },
      manifest: {
        name: 'Open-Outliner',
        short_name: 'Outliner',
        description: 'Offline-first collaborative outliner',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#0969da',
        icons: [],
      },
    }),
  ],
  server: {
    port: 5173,
    // Dev: keep `/rpc` and the collab WebSocket same-origin so the httpOnly
    // session cookie (set via the `/rpc` proxy) is always attached. Pointing
    // the browser at `ws://localhost:8788` directly is host-same but can still
    // lose the cookie on some browsers / private modes; a path proxy is the
    // reliable dev setup. Override targets if the server isn't on defaults.
    proxy: {
      '/rpc': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8787',
        changeOrigin: true,
      },
      '/collaboration': {
        target: process.env.VITE_WS_PROXY_TARGET ?? 'http://localhost:8788',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
