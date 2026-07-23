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
  },
});
