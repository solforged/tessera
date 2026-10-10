declare global { const __TESSERA_DEMO__: boolean; const __TESSERA_ANDROID__: boolean; }

/** Replaced by Vite; ordinary builds and Bun tests retain the native app. */
export const DEMO = typeof __TESSERA_DEMO__ !== 'undefined' && __TESSERA_DEMO__;
export const ANDROID = typeof __TESSERA_ANDROID__ !== 'undefined' && __TESSERA_ANDROID__;
/** The notebook runs in this page's app, not behind the loopback service: there is no
 * service, no backups, and no URL the page can load a resource from directly. */
export const EMBEDDED = DEMO || ANDROID;
