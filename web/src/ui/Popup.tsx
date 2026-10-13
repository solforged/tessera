import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { visualViewportBounds } from './visual-viewport';
import { anchoredPopupPosition, popupBounds } from './popup-position';

export type PopupAnchor = HTMLElement | DOMRect | (() => DOMRect | null);
/** `anchor` hangs the panel off its trigger; `top` centres it near the top of the viewport, for palettes; `sheet` rises
 * from the bottom edge at full width, for touch screens. */
export type PopupPlacement = 'anchor' | 'top' | 'sheet';
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
const stack: symbol[] = [];
let mountVersion = 0;

function retirePanel(panel: HTMLDivElement) {
  panel.classList.remove('popup', 'popup-enter');
  panel.classList.add('popup-exit');
  panel.inert = true;
  panel.setAttribute('aria-hidden', 'true');
  panel.removeAttribute('id');
  for (const element of panel.querySelectorAll('[id]')) element.removeAttribute('id');

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (motion.matches) {
    panel.remove();
    return;
  }

  // Portal has removed its wrapper; keep only the already-disposed DOM panel.
  document.body.append(panel);
  const animation = panel.getAnimations().find(animation => animation instanceof CSSAnimation && animation.animationName === 'popup-out');
  const timing = animation?.effect?.getComputedTiming();
  const duration = timing?.activeDuration;
  const end = timing?.endTime;
  if (!animation || typeof duration !== 'number' || duration <= 0 || typeof end !== 'number' || !Number.isFinite(end) || end <= 0) {
    panel.remove();
    return;
  }

  let removed = false;
  let timer = 0;
  const remove = () => {
    if (removed) return;
    removed = true;
    window.clearTimeout(timer);
    motion.removeEventListener('change', motionChanged);
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
  const token = Symbol('popup');
  let panel!: HTMLDivElement;
  const [position, setPosition] = createSignal<{ left: number; top: number; height: number; visible: boolean; clipped?: boolean }>({ left: 8, top: 8, height: 0, visible: false });
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
  const anchorRect = () => typeof props.anchor === 'function' ? props.anchor() : props.anchor instanceof HTMLElement ? props.anchor.getBoundingClientRect() : props.anchor;
  let frame = 0;
  let disposed = false;
  let size: { width: number; height: number } | undefined;
  const place = () => {
    if (disposed || props.ready === false) return;
    const viewport = popupBounds(visualViewportBounds(), props.placement === undefined || props.placement === 'anchor' ? props.bounds?.() : null);
    if (props.placement === 'sheet') {
      const height = Math.min(panel.scrollHeight + panel.offsetHeight - panel.clientHeight, Math.round(viewport.height * 0.85));
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
    let contentHeight: number;
    if (props.fixedSize && size?.width === width) contentHeight = size.height;
    else if (props.fitContent) {
      // Measure the full body without losing scroll positions when it temporarily expands.
      const scrolled: [Element, number, number][] = [[panel, panel.scrollTop, panel.scrollLeft]];
      for (const element of panel.querySelectorAll('*')) {
        if (element.scrollTop || element.scrollLeft) scrolled.push([element, element.scrollTop, element.scrollLeft]);
      }
      const maxHeight = panel.style.maxHeight;
      panel.style.maxHeight = 'none';
      contentHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
      panel.style.maxHeight = maxHeight;
      for (const [element, top, left] of scrolled) { element.scrollTop = top; element.scrollLeft = left; }
    // scrollHeight leaves out the border that max-height includes; without it a short menu scrolls by 2 px and WebKit shows a scrollbar.
    } else contentHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
    if (props.fixedSize && size?.width !== width) size = { width, height: contentHeight };
    setPosition(anchoredPopupPosition(rect, viewport, width, contentHeight, props.role === 'menu' ? Infinity : 560));
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
      if (panel.isConnected && topmost()) (panel.querySelector<HTMLElement>('input, textarea') ?? panel.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]'))?.focus();
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
  return <Portal><div ref={panel} class={`popup${props.placement === 'sheet' ? ' popup-sheet' : ''}${position().visible ? ' popup-enter' : ''} ${props.class ?? ''}`} role={props.role ?? 'dialog'} aria-label={props.label} style={{ ...props.style, left: `${position().left}px`, top: `${position().top}px`, width: width(), height: props.fixedSize && position().visible ? `${position().height}px` : undefined, 'max-height': `${position().height}px`, overflow: position().clipped ? 'auto' : undefined, visibility: position().visible ? 'visible' : 'hidden' }}>{props.children}</div></Portal>;
}
