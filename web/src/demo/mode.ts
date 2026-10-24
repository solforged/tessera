declare global { const __TESSERA_DEMO__: boolean; const __TESSERA_MOBILE__: boolean; }

/** Replaced by Vite; ordinary builds and Bun tests retain the native app. */
export const DEMO = typeof __TESSERA_DEMO__ !== 'undefined' && __TESSERA_DEMO__;
/** The Android or iOS app: a phone that pairs with the Mac, not a computer. */
export const MOBILE = typeof __TESSERA_MOBILE__ !== 'undefined' && __TESSERA_MOBILE__;
/** The notebook runs in this page's app, not behind the loopback service: there is no
 * service, no automatic backups, and no URL the page can load a resource from directly. */
export const EMBEDDED = DEMO || MOBILE;
