import { createSignal, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { haptic } from './haptics';
import { Menu } from './Menu';
import type { MenuItem } from './Menu';

/** Where the finger is, in viewport coordinates. */
export interface Press { x: number; y: number }

export interface LongPressOptions {
  /** How long the finger rests before the press counts. Default 450. */
  ms?: number;
  /** How far it may stray, in pixels, before the press becomes a drag. Default 10. */
  slop?: number;
  /** Descendants a press does not count on (a checkbox, a control with its own long press). */
  ignore?: string;
}

/** After a long press the finger's release may still produce a click, which must not open the row beneath the menu. A new
 * press, or this long, ends the wait. */
const CLICK_WINDOW_MS = 800;

/** Recognises a touch long press on `element` and calls `onLongPress` once. It cancels when the finger moves more than `slop`,
 * when the page scrolls, or when the browser takes the touch over, and it keeps the system's text-selection callout from
 * starting while the finger rests. The click that would follow the release is swallowed. Touch only: a mouse has right-click.
 * Returns the function that removes it, for `onCleanup`:
 *
 *     <div ref={row => onCleanup(longPress(row, () => openContextMenu({ source: row, label: 'Actions', items })))}> */
export function longPress(element: HTMLElement, onLongPress: (press: Press) => void, options: LongPressOptions = {}): () => void {
  const { ms = 450, slop = 10, ignore } = options;
  let timer = 0;
  let start: { id: number; x: number; y: number } | undefined;
  let swallow = false;
  let swallowTimer = 0;
  const end = (event?: Event) => {
    if (event instanceof PointerEvent && event.pointerId !== start?.id) return;
    window.clearTimeout(timer);
    start = undefined;
    element.removeAttribute('data-pressing');
    window.removeEventListener('scroll', end, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
  };
  const down = (event: PointerEvent) => {
    swallow = false;
    if (event.pointerType !== 'touch' || !event.isPrimary || start || (ignore && event.target instanceof Element && event.target.closest(ignore))) return;
    start = { id: event.pointerId, x: event.clientX, y: event.clientY };
    // While the finger rests, the row is neither selectable nor offers the system callout; the stylesheet keys on this.
    element.setAttribute('data-pressing', '');
    window.addEventListener('scroll', end, { capture: true, passive: true });
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    const { x, y } = start;
    timer = window.setTimeout(() => {
      window.getSelection()?.removeAllRanges();
      swallow = true;
      window.clearTimeout(swallowTimer);
      swallowTimer = window.setTimeout(() => { swallow = false; }, CLICK_WINDOW_MS);
      onLongPress({ x, y });
    }, ms);
  };
  const move = (event: PointerEvent) => {
    if (start && event.pointerId === start.id && Math.hypot(event.clientX - start.x, event.clientY - start.y) > slop) end(event);
  };
  const click = (event: MouseEvent) => {
    if (!swallow || !(event.target instanceof Node) || !element.contains(event.target)) return;
    swallow = false;
    event.preventDefault(); event.stopPropagation();
  };
  // Some engines open their own context menu on a long press; the row's is the one.
  const context = (event: Event) => { if (start || swallow) event.preventDefault(); };
  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  element.addEventListener('contextmenu', context);
  window.addEventListener('click', click, true);
  return () => {
    end();
    window.clearTimeout(swallowTimer);
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('pointermove', move);
    element.removeEventListener('contextmenu', context);
    window.removeEventListener('click', click, true);
  };
}

/** Longhands that would replay or retarget the copy rather than draw it. */
const NOT_COPIED = /^(-webkit-)?(animation|transition)|^will-change$|^cursor$|^pointer-events$/;

/** Copies the computed style of `from` onto `to`, so the copy looks the same outside the ancestors that styled the original. */
function freeze(from: Element, to: HTMLElement | SVGElement, pseudo?: '::before' | '::after') {
  const style = getComputedStyle(from, pseudo);
  for (let at = 0; at < style.length; at++) {
    const name = style[at]!;
    if (name !== 'content' && !NOT_COPIED.test(name)) to.style.setProperty(name, style.getPropertyValue(name), style.getPropertyPriority(name));
  }
}

/** A pseudo-element's text as a real element, so the copy keeps a bullet or a quote mark. */
function pseudoCopy(from: Element, pseudo: '::before' | '::after') {
  const content = getComputedStyle(from, pseudo).content;
  if (!content || content === 'none' || content === 'normal' || content.startsWith('url(')) return null;
  const span = document.createElement('span');
  freeze(from, span, pseudo);
  span.textContent = /^(["']).*\1$/.test(content) ? content.slice(1, -1) : '';
  return span;
}

function freezeTree(from: Element, to: Element) {
  if (to instanceof HTMLElement || to instanceof SVGElement) freeze(from, to);
  to.removeAttribute('id');
  to.removeAttribute('tabindex');
  const sources = Array.from(from.children), copies = Array.from(to.children);
  sources.forEach((child, at) => { if (copies[at]) freezeTree(child, copies[at]!); });
  const before = pseudoCopy(from, '::before'), after = pseudoCopy(from, '::after');
  if (before) to.prepend(before);
  if (after) to.append(after);
}

/** A picture of `source` that holds still: its elements carry the styles they had, and nothing in it answers a touch. It is laid
 * at `left` and `top` inside the card that carries it, at the row's own size. */
function lifted(source: HTMLElement, rect: DOMRect, left: number, top: number) {
  const copy = source.cloneNode(true) as HTMLElement;
  freezeTree(source, copy);
  // Whatever positioned the original (a virtualised row's transform, a sticky offset) is replaced by the row's place in the card.
  Object.assign(copy.style, { position: 'absolute', inset: 'auto', left: `${left}px`, top: `${top}px`, transform: 'none', translate: 'none', margin: '0', width: `${rect.width}px`, height: `${rect.height}px` });
  copy.inert = true;
  copy.setAttribute('aria-hidden', 'true');
  return copy;
}

export interface ContextMenuOptions {
  /** The row the press began on. It stays where it is; a copy lifts above the blurred page. */
  source: HTMLElement;
  /** The menu's accessible name. */
  label: string;
  items: MenuItem[];
  /** A line above the rows, only when the rows cannot say what they act on (see Menu `caption`). */
  caption?: JSX.Element;
  /** An extra class on the lifted copy's card, for a lane that dresses a bare line as a leaf. */
  liftClass?: string;
  /** Where focus goes when the menu closes. */
  returnFocus?: HTMLElement | (() => HTMLElement | null);
  /** Runs once the menu has closed, however it closed. */
  onClose?(): void;
}

/** How far the card stands out from the row it lifts: a bare line needs room around its text. */
const LIFT_PAD_X = 4, LIFT_PAD_Y = 4;
/** How far the card stands from the menu, past the menu's own offset. */
const LIFT_GAP = 16;
let current: (() => void) | undefined;

/** A row's context menu: the page dims and blurs, the row lifts as a non-interactive copy at its own place, and the menu opens
 * under it (above it when there is no room below). A medium haptic marks the opening. A press on the backdrop, Escape or a
 * choice closes it. One at a time. Wire it with `longPress`. Returns the function that closes it. */
export function openContextMenu(options: ContextMenuOptions): () => void {
  current?.();
  haptic('medium');
  const rect = options.source.getBoundingClientRect();
  // The card spreads past the row, but not off the screen.
  const card = { left: Math.max(LIFT_PAD_X, rect.left - LIFT_PAD_X), top: rect.top - LIFT_PAD_Y };
  const cardRight = Math.min(window.innerWidth - LIFT_PAD_X, rect.right + LIFT_PAD_X);
  const cardBox = new DOMRect(card.left, card.top, cardRight - card.left, rect.height + 2 * LIFT_PAD_Y);
  const host = document.createElement('div');
  host.className = 'context-layer';
  document.body.append(host);
  let closed = false;
  let dispose = () => {};
  const [open, setOpen] = createSignal(true);
  const finish = () => {
    dispose();
    host.remove();
    options.onClose?.();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (current === close) current = undefined;
    setOpen(false);
    // The backdrop and the copy fade for the UI motion token; reduced motion zeroes it and they go at once.
    const motion = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-ui'));
    if (!(motion > 0)) { finish(); return; }
    void host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: motion, easing: 'ease', fill: 'forwards' }).finished.then(finish, finish);
  };
  dispose = render(() => <>
    <div class="context-backdrop" aria-hidden="true" />
    <div class={`context-lift ${options.liftClass ?? ''}`} style={{ left: `${cardBox.left}px`, top: `${cardBox.top}px`, width: `${cardBox.width}px`, height: `${cardBox.height}px` }} aria-hidden="true"
      ref={element => { element.append(lifted(options.source, rect, rect.left - cardBox.left, LIFT_PAD_Y)); }} />
    <Show when={open()}>
      <Menu anchor={new DOMRect(cardBox.left, cardBox.top - LIFT_GAP, cardBox.width, cardBox.height + 2 * LIFT_GAP)} label={options.label} items={options.items} caption={options.caption} returnFocus={options.returnFocus} modal class="context-menu" onDismiss={close} />
    </Show>
  </>, host);
  current = close;
  return close;
}
