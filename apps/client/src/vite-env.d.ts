/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of the Colyseus server. Defaults to localhost in dev. */
  readonly VITE_SERVER_URL?: string;
}
