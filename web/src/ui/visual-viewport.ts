import { createSignal, onCleanup } from 'solid-js';

/** Bounds in layout-viewport coordinates, including browser keyboards and panning. */
export function visualViewportBounds() {
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0, left = viewport?.offsetLeft ?? 0;
  const height = viewport?.height ?? window.innerHeight, width = viewport?.width ?? window.innerWidth;
  return { top, left, height, width, bottom: top + height, right: left + width };
}

export function createVisualViewport() {
  const [bounds, setBounds] = createSignal(visualViewportBounds());
  const update = () => setBounds(visualViewportBounds());
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  onCleanup(() => {
    window.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('scroll', update);
  });
  return bounds;
}
