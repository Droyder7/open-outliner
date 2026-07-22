/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional Hocuspocus WebSocket URL. Unset ⇒ local-only (y-indexeddb) mode. */
  readonly VITE_SYNC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
