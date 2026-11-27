/**
 * Canonical media queries matching the CSS breakpoints in tokens.css and shell.css.
 * Kept in core/ (DOM-only, no UI framework imports) so every tier can share one source of truth.
 */
export const phoneQuery = '(max-width: 599px) and (pointer: coarse)';
export const coarseQuery = '(pointer: coarse)';
export const touchOnlyQuery = '(hover: none) and (pointer: coarse)';
export const noHoverQuery = '(hover: none)';
export const wideTouchQuery = '(pointer: coarse) and (min-width: 900px)';
export const narrowQuery = '(max-width: 1047px)';
export const tabbedQuery = '(max-width: 839px)';
export const previewQuery = '(min-width: 840px)';
export const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

/** Synchronous media-query check without subscribing to a reactive signal. */
export function matchesMedia(query: string): boolean {
  return window.matchMedia(query).matches;
}

export const matchesCoarsePointer = () => matchesMedia(coarseQuery);
export const matchesTouchOnly = () => matchesMedia(touchOnlyQuery);
export const matchesNoHover = () => matchesMedia(noHoverQuery);
export const matchesWideTouch = () => matchesMedia(wideTouchQuery);
export const matchesReducedMotion = () => matchesMedia(reducedMotionQuery);
