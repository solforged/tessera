import { batch, createContext, createUniqueId, useContext, createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { visualViewportBounds } from './visual-viewport';
import { anchorInBounds, anchoredPopupPosition, popupBounds } from './popup-position';
import type { PopupSide } from './popup-position';
import { Button } from './Button';
import { Icon } from './Icon';
import { isPhone } from './phone';
import './overlays.css';

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
  /** Defaults to the first input or enabled button, once the content has appeared. A modal popup with nothing to focus holds
   * focus on its own panel; any other leaves focus where it is. false retains the page's focus, unless the popup is modal (the
   * page behind it cannot keep focus). */
  autofocus?: boolean;
  /** Where focus goes on every way of closing, for a trigger that is replaced or re-rendered while the popup is open.
   * Otherwise it is the trigger when that can take focus, however the popup was opened; a field or editor that held focus
   * before the popup opened (or the one a closing popup would have returned to, for a chained popup) comes first; a pane's
   * keyboard owner, or an open modal dialog's first control, is the last resort. */
  returnFocus?: HTMLElement | (() => HTMLElement | null);
  /** While this returns true an outside press keeps the popup (and gives the panel a nudge); Escape and an explicit
   * Cancel still close it. Forms with typed input pass it. */
  dirty?: () => boolean;
  /** Traps Tab inside the popup, marks it `aria-modal` and makes the page behind inert. Defaults on for dialogs placed
   * `top`, anchored to the page body, or as a sheet, and for every sheet; menus, listboxes, pickers and previews are not
   * modal and close when Tab leaves them. */
  modal?: boolean;
  /** A sheet dims the page behind it; the scrim fades in and out with the sheet and a press on it dismisses. Default on.
   * `scrim={false}` is the no-dim variant: the page stays visible (and inert) behind the sheet, and a press on it still
   * dismisses, for a sheet that edits what lies behind it (reader settings). */
  scrim?: boolean;
  /** The sheet's name in its head, centred between the grabber and the close circle. Phone sheets only: without it the
   * head carries just the grabber and the close circle, and the content names itself. */
  title?: string;
}
/** A sheet owns one popup surface; its editors render in that surface rather than opening another. */
const InlinePopupContext = createContext(false);
export function InlinePopups(props: { children: JSX.Element }) {
  return <InlinePopupContext.Provider value={true}>{props.children}</InlinePopupContext.Provider>;
}

interface Layer { modal: boolean; panel?: HTMLElement; scrim?: HTMLElement }
/** The open popups, topmost last. Only the topmost owns Escape, Tab and outside presses. */
const stack: Layer[] = [];
let mountVersion = 0;

/** What a closing popup hands focus back to, with the selection to put back inside it. */
interface FocusRecord { element: HTMLElement | null; ranges: Range[]; input: [number | null, number | null] | null }
// A popup that opens while another is closing (a menu item's follow-up, a command that opens a calendar) returns to
// where the first one would have: its own opener is the retired item or the palette's input, both gone by then.
let handoff: { record: FocusRecord; panel: HTMLElement; at: number } | null = null;
const HANDOFF_MS = 500;
// The latest press anywhere, to tell a popup the user opened by pressing elsewhere from one a closing popup's pick opened.
const press = { target: null as EventTarget | null, at: -Infinity };
let trackingPresses = false;
function trackPresses() {
  if (trackingPresses) return;
  trackingPresses = true;
  window.addEventListener('pointerdown', event => { press.target = event.target; press.at = performance.now(); }, true);
}
// True from one popup closing until the end of that task, so a popup replacing it crossfades in place.
let retiredThisTick = false;

const CONTROL = 'button, [role="button"], summary, [aria-haspopup]';
// Anchors that can say "expanded": controls, and cells or other focusable elements a value editor opens from.
const EXPANDABLE = `${CONTROL}, [role], [tabindex], a[href], input, select, textarea`;
const TABBABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';
const SETTLE_MS = 90;
/** How far a phone sheet floats in from the screen's left, right and bottom edges. */
const PHONE_SHEET_INSET = 8;
// What the user may be typing into: focus that sat in one of these before a popup opened returns to it, not to the trigger.
const EDITING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .cm-content';

function focusRecord(element: HTMLElement | null): FocusRecord {
  const selection = window.getSelection();
  const ranges = element && selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()).filter(range => element.contains(range.commonAncestorContainer)) : [];
  return { element, ranges, input: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? [element.selectionStart, element.selectionEnd] : null };
}

function restoreFocus(record: FocusRecord, element: HTMLElement) {
  element.focus({ preventScroll: true });
  if (record.element !== element) return;
  if (record.input && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    try { element.setSelectionRange(record.input[0], record.input[1]); } catch { /* inputs without a selection (number, email) keep their caret */ }
  } else if (record.ranges.length) {
    const current = window.getSelection();
    if (!current) return;
    current.removeAllRanges();
    for (const range of record.ranges) if (range.startContainer.isConnected && range.endContainer.isConnected) current.addRange(range);
  }
}

/** A pane's keyboard owner: its title field, its live editor, or the outline itself. */
function paneOwner(pane: Element | null | undefined) {
  return pane?.querySelector<HTMLElement>('.title-input') ?? pane?.querySelector<HTMLElement>('.editor-host.host-active .cm-content') ?? pane?.querySelector<HTMLElement>('.outline-pane') ?? null;
}

/** Focus can land here: attached, shown, and not behind another popup's inert page or a retiring panel. */
function reachable(element: HTMLElement | null | undefined): element is HTMLElement {
  return !!element && element.isConnected && !element.closest('[inert]') && !element.hasAttribute('disabled') && element.getClientRects().length > 0;
}

function tabbables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(element => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled && !element.closest('[inert]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
}

/** An open modal `<dialog>` sits in the top layer above everything else, so a popup must render inside it to be seen. */
function modalDialog(): HTMLElement | null {
  const dialogs = document.querySelectorAll<HTMLElement>('dialog[open]');
  for (let i = dialogs.length - 1; i >= 0; i--) {
    try { if (dialogs[i]!.matches(':modal')) return dialogs[i]!; } catch { return null; }
  }
  return null;
}

/** Ancestors that can hide part of an element: scrollers and clips between it and the window, as its positioning allows. */
function clippingAncestors(element: Element): Element[] {
  const clips: Element[] = [];
  const own = getComputedStyle(element).position;
  if (own === 'fixed') return clips;
  let escapes = own === 'absolute';
  for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (escapes) {
      // An absolutely positioned box is clipped from its containing block outward, not by the scrollers inside it.
      if (style.position === 'static') continue;
      escapes = false;
    }
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') clips.push(node);
    if (style.position === 'fixed') break;
    if (style.position === 'absolute') escapes = true;
  }
  return clips;
}

const inerted = new Set<HTMLElement>();
const ROOTS_APART: Record<string, true> = { HEAD: true, SCRIPT: true, STYLE: true, LINK: true, TEMPLATE: true, META: true };
/** While a modal popup is open the page outside it (and outside any popup opened from it) neither takes pointer nor key
 * input nor focus; closing releases exactly what was marked. */
function syncInert() {
  const wanted = new Set<HTMLElement>();
  let modal = stack.length - 1;
  while (modal >= 0 && !stack[modal]!.modal) modal--;
  if (modal >= 0) {
    const live = new Set<Element>();
    for (const layer of stack.slice(modal)) for (const part of [layer.panel, layer.scrim]) if (part?.isConnected) live.add(part);
    const keep = new Set<Element>(live);
    for (const part of live) for (let node = part.parentElement; node && node !== document.documentElement; node = node.parentElement) keep.add(node);
    for (const node of keep) {
      for (const sibling of node.parentElement?.children ?? []) {
        if (sibling instanceof HTMLElement && !keep.has(sibling) && !(sibling.tagName in ROOTS_APART) && !sibling.matches('.popup-exit, .popup-exit-shield, .popup-scrim-exit')) wanted.add(sibling);
      }
    }
  }
  for (const element of inerted) if (!wanted.has(element) || !element.isConnected) { element.inert = false; inerted.delete(element); }
  for (const element of wanted) if (!element.inert) { element.inert = true; inerted.add(element); }
}

/** Where focus can rest in a modal dialog once the control that had it inside has gone (the closing popup's own controls excepted). */
function dialogHome(dialog: HTMLElement, closing: HTMLElement) {
  const first = tabbables(dialog).find(element => !closing.contains(element));
  if (first) return first;
  if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
  return dialog;
}

/** Takes the rest of one press away from the page: the mousedown that would move focus (off the popup, or onto what the popup
 * was holding inert) and the touch end, mouse up and click that would act on whatever lies under the finger. It ends with the
 * click, the next press or a short timeout, so only this press is lost. */
function consumePress(first: PointerEvent) {
  const types = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchend'] as const;
  let released = false;
  let timer = 0;
  const finish = () => {
    window.clearTimeout(timer);
    for (const type of types) window.removeEventListener(type, swallow, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointerdown', next, true);
    window.removeEventListener('pointercancel', finish, true);
  };
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'click') finish();
  };
  const up = (event: PointerEvent) => { if (event.pointerId === first.pointerId) released = true; };
  const next = (event: PointerEvent) => { if (released || event.pointerId !== first.pointerId) finish(); };
  first.stopImmediatePropagation();
  for (const type of types) window.addEventListener(type, swallow, { capture: true, passive: false });
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointerdown', next, true);
  window.addEventListener('pointercancel', finish, true);
  timer = window.setTimeout(finish, 700);
}

function retirePanel(panel: HTMLDivElement, scrim: HTMLElement | undefined, host: HTMLElement | null, shielded: boolean) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (motion.matches) {
    panel.remove();
    scrim?.remove();
    return;
  }
  // Portal may already have detached its wrapper; reconnect before measuring the retiring panel. A modal dialog still open
  // keeps the ghost inside it, in the top layer.
  const parent = host?.isConnected ? host : document.body;
  parent.append(panel);
  const zIndex = getComputedStyle(panel).zIndex;
  panel.classList.remove('popup', 'popup-enter', 'popup-swap', 'popup-growing');
  panel.classList.add('popup-exit');
  panel.inert = true;
  panel.setAttribute('aria-hidden', 'true');
  panel.removeAttribute('id');
  for (const element of panel.querySelectorAll('[id]')) element.removeAttribute('id');
  if (scrim) {
    parent.append(scrim);
    scrim.classList.remove('popup-scrim-enter');
    scrim.classList.add('popup-scrim-exit');
  }

  const bounds = panel.getBoundingClientRect();
  const animation = panel.getAnimations().find(animation => animation instanceof CSSAnimation && /^(popup|sheet|phone-sheet|menu-pull)-out$/.test(animation.animationName));
  const timing = animation?.effect?.getComputedTiming();
  const duration = timing?.activeDuration;
  const end = timing?.endTime;
  if (!animation || typeof duration !== 'number' || duration <= 0 || typeof end !== 'number' || !Number.isFinite(end) || end <= 0) {
    panel.remove();
    scrim?.remove();
    return;
  }

  // A press inside the popup that closed it (a double tap on a menu row) must not reach the control left under its
  // footprint while it fades. Closing by keyboard, by Escape or by a press outside needs no shield: the next click is
  // deliberate, and a shield there would eat it.
  let shield: HTMLDivElement | undefined;
  const swallow = (event: Event) => {
    if (event.target !== shield && event.target !== scrim) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const events = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel'] as const;
  if (shielded) {
    shield = document.createElement('div');
    shield.className = 'popup-exit-shield';
    shield.setAttribute('aria-hidden', 'true');
    Object.assign(shield.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, zIndex });
    parent.append(shield);
    if (scrim) scrim.style.pointerEvents = 'auto';
    // Capture before document-level outside-dismiss and selection handlers can interpret a trailing tap.
    for (const type of events) window.addEventListener(type, swallow, { capture: true, passive: false });
  }

  let removed = false;
  let timer = 0;
  const remove = () => {
    if (removed) return;
    removed = true;
    window.clearTimeout(timer);
    motion.removeEventListener('change', motionChanged);
    if (shielded) for (const type of events) window.removeEventListener(type, swallow, true);
    shield?.remove();
    scrim?.remove();
    panel.remove();
    animation.cancel();
  };
  const motionChanged = () => { if (motion.matches) remove(); };
  motion.addEventListener('change', motionChanged);
  // Completion/cancellation is authoritative; bound paused or stalled effects too.
  timer = window.setTimeout(remove, Math.ceil(end * 2));
  void animation.finished.then(remove, remove);
}

interface Position { left: number; top: number; height: number; visible: boolean; clipped?: boolean; side?: PopupSide; originX?: number }

/** Mount conditionally. Only the topmost popup owns Escape, Tab and outside presses. */
export function Popup(props: PopupProps) {
  if (useContext(InlinePopupContext)) return <div class={`popup-inline ${props.class ?? ''}`} role={props.role ?? 'group'} aria-label={props.label}>{props.children}</div>;
  let panel!: HTMLDivElement;
  let scrim: HTMLDivElement | undefined;
  const layer: Layer = { modal: props.modal ?? (props.placement === 'sheet' || ((props.role ?? 'dialog') === 'dialog' && (props.placement === 'top' || props.anchor === document.body))) };
  // A sheet on a phone floats inset from the screen's edges (styles in overlays.css); elsewhere it docks to the bottom edge.
  const sheetInset = props.placement === 'sheet' && isPhone() ? PHONE_SHEET_INSET : 0;
  const [position, setPosition] = createSignal<Position>({ left: 8, top: 8, height: 0, visible: false });
  // Placed and shown (focusable) from the first measure; revealed once the content has stopped changing, so a popup
  // whose rows land a frame later enters at its final size instead of growing mid-fade.
  const [revealed, setRevealed] = createSignal(false);
  const [growing, setGrowing] = createSignal(false);
  const [dragDistance, setDragDistance] = createSignal(0);
  let drag: { pointer: number; y: number } | undefined;

  trackPresses();
  const swap = retiredThisTick;
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && active !== document.body ? active : null;
  const stale = !focused || !focused.isConnected || !!focused.closest('[inert]') || !!handoff?.panel.contains(focused);
  // A chained popup (a menu pick's follow-up, a command's calendar) returns where the closing one would have. One the user
  // opened with a press elsewhere since (WebKit leaves focus on body after any click, so focus alone cannot tell) is its own:
  // that press's target, the trigger, takes focus back.
  const pressedElsewhere = !!handoff && press.at >= handoff.at - 50 && press.target instanceof Node && press.target.isConnected && !handoff.panel.contains(press.target);
  const inherited = handoff && props.role !== 'tooltip' && performance.now() - handoff.at < HANDOFF_MS && stale && !pressedElsewhere ? handoff.record : null;
  const anchorElement = props.anchor instanceof HTMLElement && props.anchor !== document.body ? props.anchor : null;
  const mount = modalDialog();
  // The trigger takes focus back on every close however the popup was opened (a click focuses no button in WebKit, and a
  // pane's keyboard owner is no better than the control the user acted on). The element focused before opening stays
  // first when it was a field or editor outside the trigger, and for a popup chained from another.
  const pane = focused?.closest('.pane') ?? anchorElement?.closest('.pane') ?? document.querySelector('.pane.active');
  const record = inherited ?? focusRecord(focused);
  const keepsFocused = inherited !== null || (!!focused && focused !== anchorElement && !anchorElement?.contains(focused) && focused.matches(EDITING));
  const id = createUniqueId();
  let tookFocus = !!inherited;
  let skipRestore = false;
  let lastInside = 0;
  let pressedOpener = false;

  // A trigger can unmount while its popup stays open (Stop removes the running clock that opened Work sessions); the
  // popup then keeps its last place instead of jumping to the viewport's corner with a detached element's empty box.
  let lastRect: DOMRect | null = null;
  const anchorRect = () => {
    if (props.anchor instanceof HTMLElement && !props.anchor.isConnected) return lastRect;
    const rect = typeof props.anchor === 'function' ? props.anchor() : props.anchor instanceof HTMLElement ? props.anchor.getBoundingClientRect() : props.anchor;
    if (rect) lastRect = rect;
    return rect;
  };
  const following = () => (typeof props.anchor === 'function' || anchorElement !== null) && props.placement !== 'top' && props.placement !== 'sheet';

  let frame = 0;
  let disposed = false;
  let dirty = true;
  let placed = false;
  let placedAt = 0;
  let placedRect: DOMRect | null = null;
  let stamp = '';
  let quiet = 0;
  let growTimer = 0;
  let size: { width: number; height: number } | undefined;
  // A popup keeps the side of its trigger it first opened on, so drilling in, typing or growing never jumps it across.
  let lastSide: PopupSide | undefined;
  let locked: PopupSide | undefined;
  let clips: Element[] | undefined;
  let headerBottom: (() => number) | undefined;
  let anchorSeen = false;
  let closingAnchor = false;
  let detached = 0;
  let shrunkAt = -Infinity;
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
  const measure = () => `${panel.scrollHeight},${panel.scrollWidth},${panel.offsetWidth}`;
  const commit = (next: Position) => {
    const previous = position();
    batch(() => {
      if (next.height < previous.height - 0.5) shrunkAt = performance.now();
      // Growth glides away from the trigger; a shrinking list snaps so typing never lags, and a list that collapsed a
      // moment ago to reload regrows at once rather than replaying the glide on every key.
      if (revealed() && !props.fixedSize && next.height > previous.height + 0.5 && performance.now() - shrunkAt > 500) {
        setGrowing(true);
        window.clearTimeout(growTimer);
        growTimer = window.setTimeout(() => setGrowing(false), 200);
      }
      setPosition(next);
    });
    if (next.side) lastSide = next.side;
    if (!placed) { placed = true; placedAt = performance.now(); queueMicrotask(attemptFocus); }
    placedRect = following() ? anchorRect() : null;
    stamp = measure();
  };
  const place = () => {
    if (disposed || props.ready === false) return;
    dirty = false;
    const viewport = popupBounds(visualViewportBounds(), props.placement === undefined || props.placement === 'anchor' || props.placement === 'below' ? props.bounds?.() : null);
    if (props.placement === 'sheet') {
      // The phone head spans the sheet's full width whatever padding the surface gave it, so it learns that padding here.
      if (sheetInset) { const padding = getComputedStyle(panel); panel.style.setProperty('--sheet-pad-l', padding.paddingLeft); panel.style.setProperty('--sheet-pad-r', padding.paddingRight); }
      // A menu sheet may rise to just under the top bar so a full page menu needs no inner scroll; forms keep 85%.
      const cap = (props.role === 'menu' ? viewport.height - 32 : Math.round(viewport.height * 0.85)) - sheetInset;
      const height = Math.min(contentHeight(), cap);
      commit({ left: viewport.left + sheetInset, top: viewport.bottom - height - sheetInset, height, visible: true, clipped: panel.scrollHeight > height });
      return;
    }
    // A panel wider than the room it may take (a 760 px editor in a 600 px pane) is held inside it; the stylesheet's own limit
    // stands otherwise, so a full-bleed phone palette stays full-bleed.
    panel.style.maxWidth = String(props.style?.['max-width'] ?? '');
    if (panel.offsetWidth > viewport.width) panel.style.maxWidth = `${Math.max(0, viewport.width - 16)}px`;
    const width = Math.max(0, Math.min(props.width ?? panel.offsetWidth, viewport.width - 16));
    // Set the pane-limited measure before asking for its wrapped content height.
    if (props.width) panel.style.width = `${width}px`;
    if (props.placement === 'top') {
      const top = viewport.top + Math.min(64, Math.round(viewport.height * 0.08));
      const height = Math.min(panel.scrollHeight + panel.offsetHeight - panel.clientHeight, viewport.bottom - top - 16, 560);
      commit({ left: Math.max(viewport.left + 8, Math.round(viewport.left + (viewport.width - width) / 2)), top, height, visible: true });
      return;
    }
    const rect = anchorRect();
    if (!rect) return;
    if (!props.fixedSize) size = undefined;
    const height = props.fixedSize && size?.width === width ? size.height : contentHeight();
    if (props.fixedSize && size?.width !== width) size = { width, height };
    const placed = anchoredPopupPosition(rect, viewport, width, height, props.role === 'menu' ? Infinity : 560, locked, props.placement === 'below', props.role !== 'menu' && props.role !== 'listbox');
    // The trigger's centre across the panel, where a phone pull-down grows from.
    commit({ ...placed, originX: (rect.left + rect.right) / 2 - placed.left });
  };
  /** Whether the anchor has scrolled or been laid out wholly beyond what clips it (its pane, scroller, header or the window). */
  const anchorGone = () => {
    if (!following()) return false;
    const rect = anchorRect();
    // A detached or hidden trigger reports an empty box at the origin, which says nothing about where it went.
    if (!rect || (rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0) || (anchorElement && !anchorElement.isConnected)) return false;
    let area = popupBounds(visualViewportBounds(), props.bounds?.());
    if (anchorElement) {
      clips ??= clippingAncestors(anchorElement);
      for (const clip of clips) area = popupBounds(area, clip.getBoundingClientRect());
      // The pane header sits above its content, so content scrolled beneath it is out of sight.
      headerBottom ??= (() => { const header = anchorElement.closest('.pane')?.querySelector(':scope > .pane-header'); return header && !header.contains(anchorElement) ? () => header.getBoundingClientRect().bottom : () => -Infinity; })();
      const top = Math.max(area.top, headerBottom());
      area = { ...area, top, height: Math.max(0, area.bottom - top) };
    }
    const inside = anchorInBounds(rect, area);
    if (inside) anchorSeen = true;
    // Only an anchor that was in view and has left it: one opened already off screen still gets its popup.
    return anchorSeen && !inside;
  };
  const tick = () => {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    // A popup never placed with its trigger already gone has nothing to show yet still answers Escape: it closes. One that was
    // placed keeps its last place when the trigger is re-rendered or removed, and a form holding typed input is never closed
    // for that (its caller clears its own state when the subject really changes).
    if (anchorElement && !anchorElement.isConnected) {
      if (++detached > 2 && !placed && !closingAnchor) { closingAnchor = true; dismiss(true); return; }
    } else detached = 0;
    if (!placed) {
      if (props.ready !== false) place();
      return;
    }
    // Every frame, before paint: content that changed, or an anchor that moved with any layout shift (a sidebar glide, a
    // pane resize, a scroller), is placed in the same frame instead of one behind.
    const changed = dirty || measure() !== stamp;
    if (changed || (following() && placedRect && moved(anchorRect(), placedRect))) place();
    if (!revealed()) {
      quiet = changed ? 0 : quiet + 1;
      if (quiet >= 1 || performance.now() - placedAt >= SETTLE_MS) { locked = lastSide; setRevealed(true); attemptFocus(); }
    }
    // A browser can refuse focus() for a moment (WebKit while a burst of stylesheets is pending), and a static menu never
    // mutates to prompt another try: ask again each frame, within the attempt window, until a control takes it. Focus the
    // user has already moved elsewhere is left alone.
    if (!focusDone) {
      const current = document.activeElement;
      if (!current || current === document.body || current === focused || panel.contains(current)) attemptFocus();
    }
    if (!closingAnchor && anchorGone()) { closingAnchor = true; dismiss(true); }
  };
  // A hidden trigger reports an empty box at the origin; that says nothing about where it went, so the popup stays put.
  const moved = (rect: DOMRect | null, from: DOMRect) => !!rect && !(rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0) && (Math.abs(rect.left - from.left) > 0.5 || Math.abs(rect.top - from.top) > 0.5 || Math.abs(rect.right - from.right) > 0.5 || Math.abs(rect.bottom - from.bottom) > 0.5);
  const reposition = () => { dirty = true; };
  createEffect(() => { if (props.ready === true) reposition(); });

  const topmost = () => !disposed && stack.at(-1) === layer;
  const dismiss = (restore: boolean) => {
    if (disposed) return;
    skipRestore = !restore;
    props.onDismiss();
    // A parent that declined (a busy form) keeps the popup; the next close still restores focus.
    skipRestore = false;
  };
  const nudge = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    panel.animate([{ scale: '1' }, { scale: '1.012' }, { scale: '1' }], { duration: 180, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  };
  /** Focus follows the first control once the content has appeared, and is asked for again each frame until it is taken: a
   * browser can refuse focus() for a moment (WebKit while a burst of stylesheets is pending). A modal popup (its page is
   * inert) holds focus on its own panel when nothing inside can take it yet; any other popup leaves focus where it is, so an
   * editor keeps typing. A menu focuses its own row once on mount; here its one tab stop is retried if that was refused. */
  let focusDone = false;
  const attemptFocus = () => {
    if (focusDone || disposed || props.role === 'tooltip' || !position().visible || !panel.isConnected || !topmost() || performance.now() - placedAt > 2000) return;
    const current = document.activeElement;
    if (current instanceof HTMLElement && current !== panel && panel.contains(current)) { focusDone = true; tookFocus = true; return; }
    if (props.autofocus === false) {
      if (layer.modal) { if (current !== panel) { panel.focus({ preventScroll: true }); tookFocus = true; } return; }
      // Touch screens start a titled menu with no row lit, so only a pointer or keyboard menu is retried, at its roving item
      // (a header's own controls are no tab stop to start on).
      const row = props.role === 'menu' && !window.matchMedia('(hover: none)').matches ? panel.querySelector<HTMLElement>('[role="menuitem"][tabindex="0"], [role="menuitemradio"][tabindex="0"]') : null;
      if (row) { row.focus({ preventScroll: true }); if (document.activeElement === row) { focusDone = true; tookFocus = true; } }
      return;
    }
    const target = panel.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled), textarea:not(:disabled)') ?? panel.querySelector<HTMLElement>('button:not(.popup-sheet-close):not(:disabled):not([tabindex="-1"]), [tabindex="0"]') ?? panel.querySelector<HTMLElement>('.popup-sheet-close');
    if (target) { target.focus({ preventScroll: true }); if (document.activeElement === target) { focusDone = true; tookFocus = true; } }
    else if (layer.modal && current !== panel) { panel.focus({ preventScroll: true }); tookFocus = true; }
  };
  const keydown = (event: KeyboardEvent) => {
    if (!topmost() || event.isComposing || event.key !== 'Escape') return;
    event.preventDefault(); event.stopImmediatePropagation(); dismiss(true);
  };
  // After the page's own handlers (a menu, an editor's Tab key, a palette's drill-in) have had their say.
  const tab = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !topmost() || props.role === 'tooltip') return;
    const items = tabbables(panel);
    const current = document.activeElement;
    const here = current instanceof HTMLElement && panel.contains(current) ? current : null;
    const wrap = () => { event.preventDefault(); (items[event.shiftKey ? items.length - 1 : 0] ?? panel).focus({ preventScroll: true }); };
    if (!here) { if (layer.modal) wrap(); return; }
    // Tabbing within the panel is ordinary; only the step that would leave it is ours.
    const flag = event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
    if (items.some(item => item !== here && here.compareDocumentPosition(item) & flag)) return;
    // A modal popup, and a form holding typed input, keep Tab inside; any other closes and hands focus back, and the
    // key then carries on from the trigger. A menu or listbox that is a sheet is modal, so it keeps Tab too.
    if (layer.modal || (props.dirty?.() && props.role !== 'menu' && props.role !== 'listbox')) wrap();
    else dismiss(true);
  };
  const outside = (event: PointerEvent) => {
    if (!topmost()) return;
    const target = event.target;
    if (target instanceof Node && panel.contains(target)) { lastInside = performance.now(); pressedOpener = false; return; }
    // The opener's own press is a toggle, handled on its click: dismissing here would let that click reopen the popup. A form
    // keeping typed input takes that press whole instead, so the opener neither steals focus nor reopens anything.
    if (anchorElement && target instanceof Node && anchorElement.contains(target)) {
      pressedOpener = anchorElement.matches(CONTROL) && props.role !== 'tooltip';
      if (pressedOpener && props.dirty?.()) { pressedOpener = false; consumePress(event); nudge(); }
      return;
    }
    pressedOpener = false;
    // consumePress takes this press whole; a shield over the retiring panel (or a hit-testable scrim) would also eat the next
    // deliberate tap, so a dismissal from outside is never shielded, even right after a press inside.
    lastInside = 0;
    // A press the popup refuses (typed input to keep) or that closes a modal one (its page is inert, so the press is not the
    // page's to act on) is taken whole: no focus change and no click on what lies beneath.
    if (props.dirty?.()) { consumePress(event); nudge(); return; }
    if (layer.modal) consumePress(event);
    // A press elsewhere moves focus there; a modal popup's page is inert, so its press can't, and focus goes home.
    dismiss(layer.modal);
  };
  // Clicking the control that opened a popup closes it. Swallowed before the opener's handler, which would otherwise mount
  // a fresh popup and replay the exit and enter.
  const opener = (event: MouseEvent) => {
    if (!pressedOpener || !topmost() || !anchorElement || !(event.target instanceof Node) || !anchorElement.contains(event.target)) return;
    pressedOpener = false;
    event.preventDefault(); event.stopImmediatePropagation();
    if (props.dirty?.()) nudge(); else dismiss(true);
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
    // A release short of the threshold glides back: the sheet's translate transitions once the dragging class is gone.
    if (!disposed) setDragDistance(0);
  };

  let expandedOpener: HTMLElement | null = null;
  let expandedBefore: string | null = null;
  let controlled: HTMLElement | null = null;
  onMount(() => {
    layer.panel = panel;
    layer.scrim = scrim;
    stack.push(layer);
    mountVersion++;
    syncInert();
    if (anchorElement?.matches(EXPANDABLE) && props.role !== 'tooltip') {
      if (anchorElement.getAttribute('aria-expanded') !== 'true') {
        expandedOpener = anchorElement;
        expandedBefore = anchorElement.getAttribute('aria-expanded');
        anchorElement.setAttribute('aria-expanded', 'true');
      }
      // The trigger names the panel it opened for assistive tech, unless the caller already points it at something.
      if (!anchorElement.hasAttribute('aria-controls')) { controlled = anchorElement; anchorElement.setAttribute('aria-controls', id); }
    }
    place();
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('keydown', tab);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('click', opener, true);
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    panel.addEventListener('focusin', () => { tookFocus = true; });
    // Content added or removed later (rows that arrive, a confirm that opens) re-measures and may still claim focus.
    const observer = new MutationObserver(() => { reposition(); attemptFocus(); });
    observer.observe(panel, { childList: true, subtree: true });
    frame = requestAnimationFrame(tick);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => {
    disposed = true;
    cancelAnimationFrame(frame);
    window.clearTimeout(growTimer);
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('keydown', tab);
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('click', opener, true);
    window.removeEventListener('resize', reposition);
    window.visualViewport?.removeEventListener('resize', reposition);
    window.visualViewport?.removeEventListener('scroll', reposition);
    const index = stack.indexOf(layer); if (index >= 0) stack.splice(index, 1);
    syncInert();
    if (expandedOpener?.getAttribute('aria-expanded') === 'true') {
      if (expandedBefore === null) expandedOpener.removeAttribute('aria-expanded');
      else expandedOpener.setAttribute('aria-expanded', expandedBefore);
    }
    if (controlled?.getAttribute('aria-controls') === id) controlled.removeAttribute('aria-controls');
    // Every way of closing returns focus: Cancel, a menu pick, Save and a parent's own dismiss as much as Escape. A popup
    // that never took focus (an editor's completions) or lost it to a deliberate target elsewhere leaves focus alone.
    // The trigger comes first whenever it can take focus; the control that held focus before is for a field being typed
    // in, or a chained popup; a pane's keyboard owner (or an open dialog's first control) is only the last resort.
    const explicit = typeof props.returnFocus === 'function' ? props.returnFocus() : props.returnFocus;
    const home = pane?.isConnected ? pane : document.querySelector('.pane.active');
    const dialog = mount?.isConnected && mount.hasAttribute('open') ? mount : null;
    const landing = (element: HTMLElement | null | undefined): element is HTMLElement => reachable(element) && (!dialog || dialog.contains(element));
    const anchorTarget = anchorElement?.matches(TABBABLE) ? anchorElement : null;
    const target = [explicit, keepsFocused ? record.element : null, anchorTarget, record.element, dialog ? dialogHome(dialog, panel) : paneOwner(home)].find(landing) ?? null;
    if (panel && props.role !== 'tooltip' && tookFocus && !skipRestore) {
      const version = mountVersion;
      const next = { record: target === record.element ? record : { element: target, ranges: [], input: null }, panel, at: performance.now() };
      handoff = next;
      window.setTimeout(() => { if (handoff === next) handoff = null; }, HANDOFF_MS);
      queueMicrotask(() => {
        // A popup mounted since (a menu's follow-up) inherited the target and returns to it in its turn.
        if (version !== mountVersion || !target) return;
        const current = document.activeElement;
        // A caller may deliberately move focus to the editor or a surviving row; only focus lost with the popup is restored.
        // A chained popup's caller that merely parks focus on the pane's keyboard owner (an outline menu's dismiss does) has
        // chosen no more than the fallback, and the trigger the chain began from outranks it.
        const parked = inherited !== null && current === paneOwner(home) && target !== current;
        if (current instanceof HTMLElement && current !== document.body && current.isConnected && !panel.contains(current) && !(current === focused && target !== focused) && !parked) return;
        restoreFocus(record, target);
      });
    }
    retiredThisTick = true;
    queueMicrotask(() => { retiredThisTick = false; });
    if (panel && revealed()) retirePanel(panel, scrim, mount, performance.now() - lastInside < 500);
  });
  const width = () => props.placement === 'sheet' ? sheetInset ? `calc(100vw - ${2 * sheetInset}px)` : '100vw' : props.width ? `${Math.max(0, Math.min(props.width, popupBounds(visualViewportBounds(), props.bounds?.()).width - 16))}px` : undefined;
  const sheet = () => props.placement === 'sheet';
  return <Portal mount={mount ?? undefined}>
    <Show when={sheet() && props.scrim !== false}><div ref={element => { scrim = element; }} class={`popup-scrim${revealed() ? ' popup-scrim-enter' : ''}`} style={{ visibility: revealed() ? 'visible' : 'hidden', opacity: revealed() ? undefined : 0 }} aria-hidden="true" /></Show>
    <div ref={panel} id={id} tabindex="-1" class={`popup${sheet() ? ' popup-sheet' : ''}${revealed() ? ` popup-enter${swap ? ' popup-swap' : ''}` : ''}${growing() ? ' popup-growing' : ''}${dragDistance() ? ' popup-sheet-dragging' : ''} ${props.class ?? ''}`} role={props.role ?? 'dialog'} aria-label={props.label} aria-modal={layer.modal ? 'true' : undefined} data-side={position().side} style={{ ...props.style, left: `${position().left}px`, top: `${position().top}px`, width: width(), height: props.fixedSize && position().visible ? `${position().height}px` : undefined, 'max-height': `${position().height}px`, overflow: position().clipped ? 'auto' : undefined, visibility: position().visible ? 'visible' : 'hidden', opacity: revealed() ? undefined : 0, translate: dragDistance() ? `0 ${dragDistance()}px` : undefined, '--popup-origin-x': position().originX === undefined ? undefined : `${position().originX}px` }}>
      {/* The grab strip lies under the whole head, so the title drags the sheet too. On a phone the close is a glass circle with a
          cross; the word stays for screen readers and for sheets on tablets and narrow windows. */}
      <Show when={sheet()}><div class="popup-sheet-tools">
        <div class="popup-sheet-grab" aria-hidden="true" onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd} onLostPointerCapture={dragEnd} />
        <Show when={props.title}>{title => <h2 class="popup-sheet-title">{title()}</h2>}</Show>
        <Button class="popup-sheet-close" label={`Close ${props.label}`} onClick={() => dismiss(true)}><span class="popup-sheet-close-word">Close</span><Icon name="close" /></Button>
      </div></Show>
      {props.children}
    </div>
  </Portal>;
}
