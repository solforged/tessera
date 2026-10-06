declare global { const __TESSERA_DEMO__: boolean; }

/** Replaced by Vite; ordinary builds and Bun tests retain the native app. */
export const DEMO = typeof __TESSERA_DEMO__ !== 'undefined' && __TESSERA_DEMO__;
