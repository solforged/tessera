import { createContext, useContext, createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { visualViewportBounds } from './visual-viewport';
import { anchoredPopupPosition, popupBounds } from './popup-position';
import { Button } from './Button';

export type PopupAnchor = HTMLElement | DOMRect | (() => DOMRect | null);
/** Anchored panels normally fit either side; `below` keeps growing lists under their trigger. */
export type PopupPlacement = 'anchor' | 'below' | 'top' | 'sheet';
export interface PopupProps {
  anchor: PopupAnchor;
  onDismiss(): void;
  children: JSX.Element;
  class?: string;
  style?: JSX.CSSProperties;
  role?: 'dialog' | 'menu' | 'listbox' | 'tooltip';
  label: string;
  width?: number;
  placement?: PopupPlacement;
  /** Measure an internally scrolling form at its natural height before placing it. */
  fitContent?: boolean;
  /** Keep asynchronous content hidden until its caller has finished loading. */
  ready?: boolean;
  /** Constrain an anchored popup to its originating pane as well as the viewport. */
  bounds?: () => DOMRect | null;
  /** Retain the first measured box while its read-only contents finish resolving. */
  fixedSize?: boolean;
  /** Defaults to the first input or enabled button. false retains editor focus. */
  autofocus?: boolean;
}
/** A sheet owns one popup surface; its editors render in that surface rather than opening another. */
const InlinePopupContext = createContext(false);
export function InlinePopups(props: { children: JSX.Element }) {
  return <InlinePopupContext.Provider value={true}>{props.children}</InlinePopupContext.Provider>;
}
const stack: symbol[] = [];
let mountVersion = 0;

function retirePanel(panel: HTMLDivElement) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (motion.matches) {
    panel.remove();
    return;
  }
  // Portal may already have detached its wrapper; reconnect before measuring the retiring panel.
  document.body.append(panel);
  const zIndex = getComputedStyle(panel).zIndex;
  panel.classList.remove('popup', 'popup-enter');
  panel.classList.add('popup-exit');
  panel.inert = true;
  panel.setAttribute('aria-hidden', 'true');
  panel.removeAttribute('id');
  for (const element of panel.querySelectorAll('[id]')) element.removeAttribute('id');

  const bounds = panel.getBoundingClientRect();
  const animation = panel.getAnimations().find(animation => animation instanceof CSSAnimation && (animation.animationName === 'popup-out' || animation.animationName === 'sheet-out'));
  const timing = animation?.effect?.getComputedTiming();
  const duration = timing?.activeDuration;
  const end = timing?.endTime;
  if (!animation || typeof duration !== 'number' || duration <= 0 || typeof end !== 'number' || !Number.isFinite(end) || end <= 0) {
    panel.remove();
    return;
  }

  // The inert visual moves away. Keep its original footprint hit-testable until the exit ends,
  // without taking focus or stopping input anywhere else (including the action's destination).
  const shield = document.createElement('div');
  shield.className = 'popup-exit-shield';
  shield.setAttribute('aria-hidden', 'true');
  Object.assign(shield.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, zIndex });
  document.body.append(shield);
  const swallow = (event: Event) => {
    if (event.target !== shield) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const events = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel'] as const;
  // Capture before document-level outside-dismiss and selection handlers can interpret a trailing tap.
  for (const type of events) window.addEventListener(type, swallow, { capture: true, passive: false });

  let removed = false;
  let timer = 0;
  const remove = () => {
    if (removed) return;
    removed = true;
    window.clearTimeout(timer);
    motion.removeEventListener('change', motionChanged);
    for (const type of events) window.removeEventListener(type, swallow, true);
    shield.remove();
    panel.remove();
    animation.cancel();
  };
  const motionChanged = () => { if (motion.matches) remove(); };
  motion.addEventListener('change', motionChanged);
  // Completion/cancellation is authoritative; bound paused or stalled effects too.
  timer = window.setTimeout(remove, Math.ceil(end * 2));
  void animation.finished.then(remove, remove);
}

/** Mount conditionally. Only the topmost popup owns Escape and outside clicks. */
export function Popup(props: PopupProps) {
  if (useContext(InlinePopupContext)) return <div class={`popup-inline ${props.class ?? ''}`} role={props.role ?? 'group'} aria-label={props.label}>{props.children}</div>;
  const token = Symbol('popup');
  let panel!: HTMLDivElement;
  const [position, setPosition] = createSignal<{ left: number; top: number; height: number; visible: boolean; clipped?: boolean }>({ left: 8, top: 8, height: 0, visible: false });
  const [dragDistance, setDragDistance] = createSignal(0);
  let drag: { pointer: number; y: number } | undefined;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Mouse-opened controls borrow the pane's keyboard owner, not the trigger that the click focused.
  // Nested popups still return to the control in their parent popup.
  const pane = focused?.closest('.pane') ?? document.querySelector('.pane.active');
  const owner = focused instanceof HTMLButtonElement && !focused.closest('.popup')
    ? pane?.querySelector<HTMLElement>('.title-input') ?? pane?.querySelector<HTMLElement>('.editor-host.host-active .cm-content') ?? pane?.querySelector<HTMLElement>('.outline-pane') : null;
  const prior = owner ?? focused;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()).filter(range => prior?.contains(range.commonAncestorContainer)) : [];
  const inputSelection: [number | null, number | null] | null = prior instanceof HTMLInputElement || prior instanceof HTMLTextAreaElement ? [prior.selectionStart, prior.selectionEnd] : null;
  // A trigger can unmount while its popup stays open (Stop removes the running clock that opened Work sessions); the
  // popup then keeps its last place instead of jumping to the viewport's corner with a detached element's empty box.
  let lastRect: DOMRect | null = null;
  const anchorRect = () => {
    if (props.anchor instanceof HTMLElement && !props.anchor.isConnected) return lastRect;
    const rect = typeof props.anchor === 'function' ? props.anchor() : props.anchor instanceof HTMLElement ? props.anchor.getBoundingClientRect() : props.anchor;
    if (rect) lastRect = rect;
    return rect;
  };
  let frame = 0;
  let disposed = false;
  let size: { width: number; height: number } | undefined;
  // A menu keeps the side of its trigger it first opened on, so drilling in or out never jumps it across the row.
  let side: 'above' | 'below' | undefined;
  const contentHeight = () => {
    if (!props.fitContent && props.placement !== 'sheet') return panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
    // Measure the full body without losing scroll positions when it temporarily expands.
    const scrolled: [Element, number, number][] = [[panel, panel.scrollTop, panel.scrollLeft]];
    for (const element of panel.querySelectorAll('*')) {
      if (element.scrollTop || element.scrollLeft) scrolled.push([element, element.scrollTop, element.scrollLeft]);
    }
    const maxHeight = panel.style.maxHeight;
    panel.style.maxHeight = 'none';
    const height = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
    panel.style.maxHeight = maxHeight;
    for (const [element, top, left] of scrolled) { element.scrollTop = top; element.scrollLeft = left; }
    return height;
  };
  const place = () => {
    if (disposed || props.ready === false) return;
    const viewport = popupBounds(visualViewportBounds(), props.placement === undefined || props.placement === 'anchor' || props.placement === 'below' ? props.bounds?.() : null);
    if (props.placement === 'sheet') {
      // A menu sheet may rise to just under the top bar so a full page menu needs no inner scroll; forms keep 85%.
      const cap = props.role === 'menu' ? viewport.height - 32 : Math.round(viewport.height * 0.85);
      const height = Math.min(contentHeight(), cap);
      setPosition({ left: viewport.left, top: viewport.bottom - height, height, visible: true, clipped: panel.scrollHeight > height });
      return;
    }
    const width = Math.max(0, Math.min(props.width ?? panel.offsetWidth, viewport.width - 16));
    // Set the pane-limited measure before asking for its wrapped content height.
    if (props.width) panel.style.width = `${width}px`;
    if (props.placement === 'top') {
      const top = viewport.top + Math.min(64, Math.round(viewport.height * 0.08));
      const height = Math.min(panel.scrollHeight + panel.offsetHeight - panel.clientHeight, viewport.bottom - top - 16, 560);
      setPosition({ left: Math.max(viewport.left + 8, Math.round(viewport.left + (viewport.width - width) / 2)), top, height, visible: true });
      return;
    }
    const rect = anchorRect();
    if (!rect) return;
    if (!props.fixedSize) size = undefined;
    const height = props.fixedSize && size?.width === width ? size.height : contentHeight();
    if (props.fixedSize && size?.width !== width) size = { width, height };
    const placed = anchoredPopupPosition(rect, viewport, width, height, props.role === 'menu' ? Infinity : 560, props.role === 'menu' ? side : undefined, props.placement === 'below');
    if (props.role === 'menu') side ??= placed.side;
    setPosition(placed);
  };
  const reposition = () => { if (!disposed) { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); } };
  createEffect(() => { if (props.ready === true) reposition(); });
  // Internal scrolling does not move the anchor and must not trigger another fit measurement.
  const scroll = (event: Event) => { if (!props.fitContent || !(event.target instanceof Node) || !panel.contains(event.target)) reposition(); };
  const topmost = () => !disposed && stack.at(-1) === token;
  const dismiss = (restore: boolean) => {
    const version = mountVersion;
    props.onDismiss();
    if (restore && props.role !== 'tooltip') queueMicrotask(() => {
      // Popups that never took focus (editor completions) must not rewind the caret to where they opened.
      if (version !== mountVersion || !prior?.isConnected || prior.closest('[inert]') || prior.contains(document.activeElement)) return;
      const active = document.activeElement;
      // A caller may deliberately restore the editor or choose a different surviving row.
      if (active instanceof HTMLElement && active !== document.body && active.isConnected && !panel.contains(active) && active !== focused) return;
      prior.focus({ preventScroll: true });
      if (inputSelection && (prior instanceof HTMLInputElement || prior instanceof HTMLTextAreaElement)) prior.setSelectionRange(inputSelection[0], inputSelection[1]);
      else if (ranges.length && window.getSelection()) {
        const current = window.getSelection()!;
        current.removeAllRanges();
        for (const range of ranges) if (range.startContainer.isConnected && range.endContainer.isConnected) current.addRange(range);
      }
    });
  };
  const keydown = (event: KeyboardEvent) => {
    if (!topmost() || event.isComposing || event.key !== 'Escape') return;
    event.preventDefault(); event.stopImmediatePropagation(); dismiss(true);
  };
  const outside = (event: PointerEvent) => {
    if (!topmost() || panel.contains(event.target as Node)) return;
    if (props.anchor instanceof HTMLElement && props.anchor.contains(event.target as Node)) return;
    dismiss(false);
  };
  const dragStart = (event: PointerEvent) => {
    if (!topmost() || event.button !== 0) return;
    drag = { pointer: event.pointerId, y: event.clientY };
    event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const dragMove = (event: PointerEvent) => {
    if (drag?.pointer === event.pointerId) setDragDistance(Math.max(0, event.clientY - drag.y));
  };
  const dragEnd = (event: PointerEvent) => {
    if (drag?.pointer !== event.pointerId) return;
    drag = undefined;
    if (event.type === 'pointerup' && dragDistance() >= Math.min(96, panel.offsetHeight / 4)) dismiss(true);
    if (!disposed) setDragDistance(0);
  };
  onMount(() => {
    stack.push(token);
    mountVersion++;
    place();
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    window.addEventListener('scroll', scroll, true);
    // Caret anchors move when the text around them reflows, without any scroll or resize.
    if (typeof props.anchor === 'function') { document.addEventListener('input', reposition, true); document.addEventListener('selectionchange', reposition); }
    const observer = new ResizeObserver(reposition);
    observer.observe(panel);
    // max-height pins the panel, so growth only shows up on its content.
    for (const child of panel.children) observer.observe(child);
    if (props.autofocus !== false) queueMicrotask(() => {
      if (panel.isConnected && topmost()) (panel.querySelector<HTMLElement>('input, textarea') ?? panel.querySelector<HTMLElement>('button:not(.popup-sheet-close):not(:disabled):not([tabindex="-1"]), [tabindex="0"]') ?? panel.querySelector<HTMLElement>('.popup-sheet-close'))?.focus({ preventScroll: true });
    });
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => {
    disposed = true;
    const index = stack.indexOf(token); if (index >= 0) stack.splice(index, 1);
    cancelAnimationFrame(frame);
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', reposition);
    window.visualViewport?.removeEventListener('resize', reposition);
    window.visualViewport?.removeEventListener('scroll', reposition);
    window.removeEventListener('scroll', scroll, true);
    document.removeEventListener('input', reposition, true);
    document.removeEventListener('selectionchange', reposition);
    if (panel && position().visible) retirePanel(panel);
  });
  const width = () => props.placement === 'sheet' ? '100vw' : props.width ? `${Math.max(0, Math.min(props.width, popupBounds(visualViewportBounds(), props.bounds?.()).width - 16))}px` : undefined;
  return <Portal><div ref={panel} class={`popup${props.placement === 'sheet' ? ' popup-sheet' : ''}${position().visible ? ' popup-enter' : ''}${dragDistance() ? ' popup-sheet-dragging' : ''} ${props.class ?? ''}`} role={props.role ?? 'dialog'} aria-label={props.label} style={{ ...props.style, left: `${position().left}px`, top: `${position().top}px`, width: width(), height: props.fixedSize && position().visible ? `${position().height}px` : undefined, 'max-height': `${position().height}px`, overflow: position().clipped ? 'auto' : undefined, visibility: position().visible ? 'visible' : 'hidden', translate: dragDistance() ? `0 ${dragDistance()}px` : undefined }}>
    <Show when={props.placement === 'sheet'}><div class="popup-sheet-tools">
      <div class="popup-sheet-grab" aria-hidden="true" onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd} onLostPointerCapture={dragEnd} />
      <Button class="popup-sheet-close" label={`Close ${props.label}`} onClick={() => dismiss(true)}>Close</Button>
    </div></Show>
    {props.children}
  </div></Portal>;
}
