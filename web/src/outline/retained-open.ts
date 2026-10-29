import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { motionMilliseconds } from '../shell/motion';

/**
 * Whether a disclosure's content stays mounted: at once when it opens, and until its close transition has run when it
 * closes. Browsers with `interpolate-size` shrink `details::details-content` from CSS, so unmounting the rows on the
 * toggle event would collapse it in one frame. Elsewhere `shell/disclosure.ts` keeps the element open through the glide,
 * so the toggle event already arrives after it. Reduced motion zeroes the duration and unmounts at once.
 */
export function createRetainedOpen(open: Accessor<boolean>): Accessor<boolean> {
  const [mounted, setMounted] = createSignal(open());
  let timer = 0;
  createEffect(() => {
    window.clearTimeout(timer);
    if (open()) { setMounted(true); return; }
    const duration = CSS.supports('interpolate-size', 'allow-keywords') ? motionMilliseconds() : 0;
    if (duration <= 0) setMounted(false);
    else timer = window.setTimeout(() => setMounted(false), duration + 40);
  });
  onCleanup(() => window.clearTimeout(timer));
  return mounted;
}
