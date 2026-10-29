import { motionMilliseconds } from './motion';

/**
 * Disclosures glide open and closed. Browsers with `interpolate-size` animate `details::details-content` from CSS;
 * the others (WebKit, Firefox) jump, so this animates the element's own height instead. A closing disclosure stays
 * `open` until its glide ends, and carries `data-closing` so its chevron turns at once.
 */
export function installDisclosureMotion() {
  if (CSS.supports('interpolate-size', 'allow-keywords')) return () => undefined;
  const running = new WeakMap<HTMLDetailsElement, Animation>();
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;
    const summary = event.target.closest('summary');
    const details = summary?.parentElement;
    if (!summary || !(details instanceof HTMLDetailsElement)) return;
    // Controls inside the summary act on their own, as they do natively.
    const control = event.target.closest('a[href], button, input, select, textarea, label');
    if (control && summary.contains(control)) return;
    const duration = motionMilliseconds();
    if (duration <= 0 || document.visibilityState !== 'visible') return;
    event.preventDefault();
    // A click mid-glide turns around from where the element is now.
    const from = details.getBoundingClientRect().height;
    const previous = running.get(details);
    if (previous) { running.delete(details); previous.onfinish = previous.oncancel = null; previous.cancel(); }
    const opening = !details.open || details.dataset.closing !== undefined;
    delete details.dataset.closing;
    // Measure the target state, then put the element back: nothing paints in between.
    details.open = opening;
    const to = details.offsetHeight;
    details.open = true;
    if (!opening) details.dataset.closing = '';
    const animation = details.animate({ height: [`${from}px`, `${to}px`] }, { duration, easing: getComputedStyle(document.documentElement).getPropertyValue('--motion-ease').trim() });
    details.style.overflow = 'clip'; details.style.boxSizing = 'border-box';
    running.set(details, animation);
    const settle = () => {
      if (running.get(details) !== animation) return;
      running.delete(details);
      details.style.removeProperty('overflow'); details.style.removeProperty('box-sizing');
      delete details.dataset.closing;
      details.open = opening;
    };
    animation.onfinish = settle;
    animation.oncancel = settle;
    // Content mounted by the toggle event (Backlinks, Unlinked mentions) is not there when `to` is measured: while the
    // glide runs, follow the content's height and retarget it, so the section grows into its rows instead of snapping.
    if (opening) {
      const natural = () => details.scrollHeight + details.offsetHeight - details.clientHeight;
      let end = to;
      const follow = () => {
        if (running.get(details) !== animation || animation.playState !== 'running') return;
        const next = natural();
        if (Math.abs(next - end) > 0.5) {
          end = next;
          (animation.effect as KeyframeEffect).setKeyframes({ height: [`${from}px`, `${end}px`] });
        }
        requestAnimationFrame(follow);
      };
      requestAnimationFrame(follow);
    }
  };
  document.addEventListener('click', onClick);
  return () => document.removeEventListener('click', onClick);
}
