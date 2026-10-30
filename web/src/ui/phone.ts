/** The phone scope: the same media query styles.css gates the phone layout on. */
export const phoneQuery = '(max-width: 599px) and (pointer: coarse)';
export function isPhone(): boolean { return window.matchMedia(phoneQuery).matches; }
