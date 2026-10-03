import { createSignal, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

export type PopupAnchor = HTMLElement | DOMRect | (() => DOMRect | null);
/** `anchor` hangs the panel off its trigger; `top` centres it near the top of the viewport, for palettes. */
export type PopupPlacement = 'anchor' | 'top';
export interface PopupProps {
  anchor: PopupAnchor;
  onDismiss(): void;
  children: JSX.Element;
  class?: string;
  role?: 'dialog' | 'menu' | 'listbox';
  label: string;
  width?: number;
  placement?: PopupPlacement;
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
  const [position, setPosition] = createSignal({ left: 8, top: 8, height: 0, visible: false });
  const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()).filter(range => prior?.contains(range.commonAncestorContainer)) : [];
  const inputSelection: [number | null, number | null] | null = prior instanceof HTMLInputElement || prior instanceof HTMLTextAreaElement ? [prior.selectionStart, prior.selectionEnd] : null;
  const anchorRect = () => typeof props.anchor === 'function' ? props.anchor() : props.anchor instanceof HTMLElement ? props.anchor.getBoundingClientRect() : props.anchor;
  let frame = 0;
  let disposed = false;
  const place = () => {
    if (disposed) return;
    const width = Math.min(props.width ?? panel.offsetWidth, window.innerWidth - 16);
    if (props.placement === 'top') {
      const top = Math.min(64, Math.round(window.innerHeight * 0.08));
      const height = Math.min(panel.scrollHeight, window.innerHeight - top - 16, 560);
      setPosition({ left: Math.max(8, Math.round((window.innerWidth - width) / 2)), top, height, visible: true });
      return;
    }
    const rect = anchorRect();
    if (!rect) return;
    const below = Math.max(0, window.innerHeight - rect.bottom - 12);
    const above = Math.max(0, rect.top - 12);
    const needed = Math.min(panel.scrollHeight, 560);
    const flip = below < Math.min(needed, 180) && above > below;
    const height = Math.min(needed, flip ? above : below);
    const start = rect.left > window.innerWidth / 2 ? rect.right - width : rect.left;
    setPosition({ left: Math.max(8, Math.min(start, window.innerWidth - width - 8)), top: flip ? rect.top - height - 4 : rect.bottom + 4, height, visible: true });
  };
  const reposition = () => { if (!disposed) { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); } };
  const topmost = () => !disposed && stack.at(-1) === token;
  const dismiss = (restore: boolean) => {
    const version = mountVersion;
    props.onDismiss();
    if (restore) queueMicrotask(() => {
      if (version !== mountVersion || !prior?.isConnected || prior.closest('[inert]')) return;
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
    window.addEventListener('scroll', reposition, true);
    const observer = new ResizeObserver(reposition);
    observer.observe(panel);
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
    window.removeEventListener('scroll', reposition, true);
    if (panel && position().visible) retirePanel(panel);
  });
  return <Portal><div ref={panel} class={`popup${position().visible ? ' popup-enter' : ''} ${props.class ?? ''}`} role={props.role ?? 'dialog'} aria-label={props.label} style={{ left: `${position().left}px`, top: `${position().top}px`, width: props.width ? `${Math.min(props.width, window.innerWidth - 16)}px` : undefined, 'max-height': `${position().height}px`, visibility: position().visible ? 'visible' : 'hidden' }}>{props.children}</div></Portal>;
}
