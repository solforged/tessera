import { createEffect, onCleanup } from 'solid-js';

/** Phone shell gestures stay outside readers, selections and horizontal controls. */
export function installPhoneGestures(options: { cover(): boolean; canBack(): boolean; back(): void; scrollTop(): void }) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let gesture: { id: number; x: number; y: number; lastX: number; lastTime: number; velocity: number; distance: number; dragging: boolean; pane: HTMLElement; width: number } | undefined;
  let settling: Animation | undefined;
  const clear = () => {
    settling?.cancel(); settling = undefined;
    gesture?.pane.style.removeProperty('transform');
    gesture?.pane.classList.remove('phone-back-dragging');
    gesture = undefined;
  };
  const start = (event: TouchEvent) => {
    clear();
    if (!options.cover() || !options.canBack() || event.touches.length !== 1 || !getSelection()?.isCollapsed || document.querySelector('.popup, .popup-exit')) return;
    const touch = event.touches[0]!;
    const target = event.target instanceof Element ? event.target : null;
    const pane = target?.closest<HTMLElement>('.pane.active');
    if (!pane || touch.clientX > 20 || target?.closest('.reader-pane, input, textarea, [contenteditable="true"]')) return;
    for (let parent = target; parent && parent !== pane; parent = parent.parentElement) {
      if (parent.scrollWidth > parent.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(parent).overflowX)) return;
    }
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastTime: event.timeStamp, velocity: 0, distance: 0, dragging: false, pane, width: pane.clientWidth };
  };
  const move = (event: TouchEvent) => {
    const current = gesture;
    if (!current) return;
    const touch = [...event.touches].find(touch => touch.identifier === current.id);
    if (!touch || event.touches.length !== 1 || !options.cover() || !getSelection()?.isCollapsed) { clear(); return; }
    const dx = touch.clientX - current.x, dy = touch.clientY - current.y;
    if (!current.dragging) {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= dx || dx < -8) { clear(); return; }
      if (dx < 8) return;
      current.dragging = true;
      current.pane.classList.add('phone-back-dragging');
    }
    event.preventDefault();
    current.velocity = (touch.clientX - current.lastX) / Math.max(1, event.timeStamp - current.lastTime);
    current.lastX = touch.clientX; current.lastTime = event.timeStamp;
    current.distance = Math.max(0, Math.min(current.width, dx));
    if (!reduced.matches) current.pane.style.transform = `translateX(${current.distance}px)`;
  };
  const end = (event: TouchEvent) => {
    const current = gesture;
    if (!current) return;
    if (!current.dragging || event.type === 'touchcancel') { clear(); return; }
    event.preventDefault();
    const commit = current.distance > current.width / 3 || current.distance > 32 && current.velocity > 0.5 && event.timeStamp - current.lastTime < 100;
    const finish = () => {
      if (gesture !== current) return;
      clear();
      if (!commit || !options.cover() || !options.canBack()) return;
      options.back();
      // The pane has slid away; the one before it settles in from the left, as it does for the Back button.
      const arriving = current.pane.querySelector<HTMLElement>(':scope > .pane-content');
      if (!arriving || reduced.matches) return;
      arriving.classList.add('phone-back-arrive');
      const done = (event: Event) => {
        if (event.target !== arriving) return;
        arriving.classList.remove('phone-back-arrive');
        arriving.removeEventListener('animationend', done);
        arriving.removeEventListener('animationcancel', done);
      };
      arriving.addEventListener('animationend', done);
      arriving.addEventListener('animationcancel', done);
    };
    if (reduced.matches) { finish(); return; }
    const style = getComputedStyle(current.pane);
    const time = style.getPropertyValue('--motion-ui').trim();
    settling = current.pane.animate([{ transform: `translateX(${current.distance}px)` }, { transform: `translateX(${commit ? current.width : 0}px)` }], { duration: parseFloat(time) * (time.endsWith('ms') ? 1 : 1000), easing: style.getPropertyValue('--motion-ease').trim(), fill: 'forwards' });
    settling.onfinish = finish;
  };
  window.addEventListener('touchstart', start, { passive: true, capture: true });
  window.addEventListener('touchmove', move, { passive: false, capture: true });
  window.addEventListener('touchend', end, { passive: false, capture: true });
  window.addEventListener('touchcancel', end, { passive: true, capture: true });
  window.addEventListener('tessera:status-bar-tap', options.scrollTop);
  // UIKit only offers scroll-to-top when its outer scroll view is off zero.
  // The native delegate bridges that tap without moving this one-pixel sentinel.
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  let sentinel = false, frame = 0;
  const arm = () => {
    cancelAnimationFrame(frame);
    if (sentinel) frame = requestAnimationFrame(() => window.scrollTo(0, 1));
  };
  const outerScroll = () => { if (sentinel && window.scrollY === 0) arm(); };
  window.addEventListener('load', arm);
  window.addEventListener('pageshow', arm);
  window.addEventListener('scroll', outerScroll, { passive: true });
  createEffect(() => {
    sentinel = ios && options.cover();
    document.documentElement.classList.toggle('phone-scroll-sentinel', sentinel);
    if (sentinel) arm();
    else { cancelAnimationFrame(frame); clear(); window.scrollTo(0, 0); }
  });
  onCleanup(() => {
    clear();
    cancelAnimationFrame(frame);
    document.documentElement.classList.remove('phone-scroll-sentinel');
    window.removeEventListener('touchstart', start, true);
    window.removeEventListener('touchmove', move, true);
    window.removeEventListener('touchend', end, true);
    window.removeEventListener('touchcancel', end, true);
    window.removeEventListener('tessera:status-bar-tap', options.scrollTop);
    window.removeEventListener('load', arm);
    window.removeEventListener('pageshow', arm);
    window.removeEventListener('scroll', outerScroll);
  });
}
