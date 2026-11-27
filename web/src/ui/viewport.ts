import type { Accessor } from 'solid-js';
import { createSignal } from 'solid-js';
import { coarseQuery, matchesMedia, narrowQuery, phoneQuery, previewQuery, tabbedQuery } from '../core/viewport';

export {
  coarseQuery,
  matchesCoarsePointer,
  matchesNoHover,
  matchesReducedMotion,
  matchesTouchOnly,
  matchesWideTouch,
  reducedMotionQuery,
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
/** Whether the narrow-sidebar drawer breakpoint applies (`max-width: 1047px`). */
export const isNarrow = sharedMedia(narrowQuery);
/** Whether the single-pane tabbed workspace breakpoint applies (`max-width: 839px`). */
export const isTabbed = sharedMedia(tabbedQuery);
/** Whether Find has room for its side-by-side preview (`min-width: 840px`). */
export const hasSplitPreview = sharedMedia(previewQuery);

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
