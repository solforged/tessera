/** A duration token in milliseconds; reduced motion zeroes the tokens, so waits and animations collapse together. */
export function motionMilliseconds(token = '--motion-ui') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const number = parseFloat(value);
  return Number.isFinite(number) ? number * (value.endsWith('ms') ? 1 : 1000) : 0;
}

/** `behavior` for a programmatic scroll: smooth, except where the reader asked for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
}
