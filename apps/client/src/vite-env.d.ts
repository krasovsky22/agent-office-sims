/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of the Colyseus server. Defaults to localhost in dev. */
  readonly VITE_SERVER_URL?: string;
  /** Set to `off` to build the grey-box office instead of the prop asset kit. */
  readonly VITE_PROPS?: string;
}
