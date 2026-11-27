import type { Accessor } from 'solid-js';
import { createSignal } from 'solid-js';
import {
  coarseQuery,
  matchesMedia,
  narrowQuery,
  noHoverQuery,
  phoneQuery,
  previewQuery,
  reducedMotionQuery,
  tabbedQuery,
  touchOnlyQuery,
  wideTouchQuery,
} from '../core/viewport';

export {
  coarseQuery,
  matchesCoarsePointer,
  matchesMedia,
  matchesNoHover,
  matchesPhone,
  matchesReducedMotion,
  matchesTouchOnly,
  matchesWideTouch,
  narrowQuery,
  noHoverQuery,
  phoneQuery,
  previewQuery,
  reducedMotionQuery,
  tabbedQuery,
  touchOnlyQuery,
  wideTouchQuery,
} from '../core/viewport';

/**
 * Creates one lazy page-lived reactive boolean for a media query, tracking both
 * MediaQueryList change events and window resizes (some WebViews change width
 * without firing a media change). Reads fresh on every call so test/emulation
 * overrides take effect immediately.
 */
function sharedMedia(query: string): Accessor<boolean> {
  let list: MediaQueryList | undefined;
  const [matched, setMatched] = createSignal(false);
  return () => {
    if (!list) {
      const media = (list = window.matchMedia(query));
      const sync = () => setMatched(media.matches);
      sync();
      media.addEventListener?.('change', sync);
      window.addEventListener('resize', sync);
    }
    matched();
    return matchesMedia(query);
  };
}

/** Whether the phone cover layout applies now (`max-width: 599px` and `pointer: coarse`). */
export const isPhone = sharedMedia(phoneQuery);
/** Whether the primary input is a coarse pointer (touch screen). */
export const isCoarsePointer = sharedMedia(coarseQuery);
/** Whether the device is touch-only (no hover, coarse pointer). */
export const isTouchOnly = sharedMedia(touchOnlyQuery);
/** Whether hover is unavailable. */
export const isNoHover = sharedMedia(noHoverQuery);
/** Whether the device is a wide touch screen (tablet / unfolded foldable >= 900px). */
export const isWideTouch = sharedMedia(wideTouchQuery);
/** Whether the narrow-sidebar drawer breakpoint applies (`max-width: 1047px`). */
export const isNarrow = sharedMedia(narrowQuery);
/** Whether the single-pane tabbed workspace breakpoint applies (`max-width: 839px`). */
export const isTabbed = sharedMedia(tabbedQuery);
/** Whether Find has room for its side-by-side preview (`min-width: 840px`). */
export const hasSplitPreview = sharedMedia(previewQuery);
/** Whether the user requested reduced motion. */
export const prefersReducedMotion = sharedMedia(reducedMotionQuery);

/**
 * Whether an on-screen touch keyboard is open. Gated on coarse pointer so short
 * desktop windows (split panes, tiled terminals) never trigger phone keyboard chrome.
 * Handles both iOS visualViewport shrinking and Android WebView resizing.
 */
export function isVirtualKeyboardOpen(
  viewportHeight: number,
  innerHeight = window.innerHeight,
  screenHeight = screen.height,
  coarse = isCoarsePointer(),
): boolean {
  if (!coarse) return false;
  return innerHeight - viewportHeight > 120 || viewportHeight < screenHeight * 0.7;
}
