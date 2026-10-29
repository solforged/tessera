import { createEffect, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { OpenTarget } from '../shell/contract';

/** Navigation identity excludes presentation, scroll and caret state. */
export function paneTargetIdentity(target: OpenTarget): string {
  switch (target.kind) {
    case 'page': return `page:${target.pageId}`;
    case 'table': return `table:${target.typeId}:${target.viewId}`;
    case 'fields': return `fields:${target.typeId ?? ''}`;
    case 'field': return `field:${target.fieldId}`;
    case 'cards': return `cards:${target.typeId}`;
    case 'reader': return `reader:${target.sourceId}:${target.snapshotId ?? ''}`;
    case 'compare': return `compare:${target.subjectId}`;
    case 'index': return `index:${target.key}`;
    // A Library tab swaps the panel in place (crossfade); only arriving at the Library is a navigation.
    case 'library': return 'library';
    // Day, Week and Tasks fade their panel in; only a new date or view arrives as a navigation.
    case 'agenda': return `agenda:${target.date ?? ''}:${target.viewId ?? ''}`;
    case 'review': return `review:${target.deckId ?? ''}`;
    default: return target.kind;
  }
}

/**
 * What a pane's entry animation follows: the destination, without what its surface reports or changes in place. A
 * reader learns its snapshot once it has loaded, and a review changes deck without leaving the pane; neither is
 * somewhere new to arrive, so neither replays the entry on a surface that is already showing.
 */
export function paneMotionIdentity(target: OpenTarget): string {
  switch (target.kind) {
    case 'reader': return `reader:${target.sourceId}`;
    case 'review': return 'review';
    default: return paneTargetIdentity(target);
  }
}

/**
 * Resolves true once `root` shows a surface with nothing under it marked `data-pane-pending`, or false when `cap` ms
 * pass first. A lazily loaded pane renders nothing until its module resolves, a microtask after mounting even when it
 * is cached, so an empty root is still pending.
 */
function settled(root: HTMLElement, cap: number): Promise<boolean> {
  const pending = () => !root.firstElementChild || !!root.querySelector('[data-pane-pending]');
  if (!pending()) return Promise.resolve(true);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  // Rendering is paused while a view transition waits, so nothing here may depend on animation frames.
  const observer = new MutationObserver(() => { if (!pending()) finish(true); });
  const timer = setTimeout(() => finish(false), cap);
  function finish(value: boolean) { observer.disconnect(); clearTimeout(timer); resolve(value); }
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-pane-pending'] });
  return promise;
}

/** A visible source cover for `sourceId` under `root`: a shelf or Reading now cover, or a source page header. */
function sourceCover(root: ParentNode, sourceId: string): HTMLElement | null {
  const id = CSS.escape(sourceId);
  for (const element of root.querySelectorAll<HTMLElement>(`[data-library-row="${id}"] .library-cover, [data-source-cover="${id}"]`)) {
    const rect = element.getBoundingClientRect();
    if (rect.width && rect.height && rect.bottom > 0 && rect.top < window.innerHeight && getComputedStyle(element).visibility === 'visible') return element;
  }
  return null;
}

/**
 * How long a transition holds the outgoing view for the incoming one to be ready. Rendering is paused meanwhile, so
 * the hold stays under a tenth of a second: the sidebar's selection, hover and every caret freeze with it. A surface
 * slower than that lands inside the turn.
 */
const holdLimit = 100;
/** How long a surface that stays hidden while it loads waits before its entry fade runs anyway. */
const entryLimit = 600;
/** How long after a click on a tab strip its selection is watched for a change that lands late, such as one waiting on a read. */
const modeWatchLimit = 500;

const motionless = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.visibilityState !== 'visible';
const canTransit = () => typeof document.startViewTransition === 'function' && !motionless();
const paneContent = (pane: string) => document.querySelector<HTMLElement>(`section.pane[data-pane="${CSS.escape(pane)}"] > .pane-content`);
/** A surface that has not mounted or still waits on its data. */
const waiting = (content: HTMLElement) => !content.firstElementChild || !!content.querySelector('[data-pane-pending], [data-pane-loading]');

type Turn = 'forward' | 'back';
/** `capture` until the browser has captured the old state and calls back, `hold` while the new state waits for its surface, `play` while both are on screen. */
type Phase = 'capture' | 'hold' | 'play';

/**
 * One view transition in progress: a leaf turning in one pane, or the row of panes changing. Only one runs at a time,
 * and only it names elements, so a skipped transition's cleanup can never strip the names of the one that replaced it.
 */
interface Flight {
  /** The pane whose surface changes, or null when only the row of panes does. */
  readonly pane: string | null;
  direction: Turn;
  sourceId: string | undefined;
  phase: Phase;
  /** Changes to apply when the browser calls back, in the order they were asked for. */
  readonly queue: (() => void)[];
  transition?: ViewTransition;
  readonly named: Set<HTMLElement>;
  readonly marked: Set<HTMLElement>;
  incoming?: HTMLElement;
  ready: boolean;
  /** The turn lifts away from a leaf caught mid-entry rather than from rest (see `liftFrom`). */
  lifted?: boolean;
}
let flight: Flight | null = null;

/**
 * What a request for a transition does while `busy` runs. Nothing runs: it starts. The running one is already on
 * screen (`play`): it is skipped and the request starts, so no turn is left half-drawn. The running one still
 * waits for its surface and the request changes the same pane: it folds in, so the turn in progress ends on the latest
 * surface instead of showing every step. Anything else (another pane, or the row) cannot fold into a held turn and
 * applies without motion rather than skip a transition whose lazy surface has not mounted.
 */
export function planTransition(busy: { pane: string | null; phase: Phase } | null, pane: string | null): 'start' | 'restart' | 'fold' | 'plain' {
  if (!busy) return 'start';
  if (busy.phase === 'play') return 'restart';
  return pane !== null && busy.pane === pane ? 'fold' : 'plain';
}

/** A change asked for before the running transition has called back lines up behind the ones already asked for. */
function join(busy: Flight, apply: () => void) {
  if (busy.phase === 'capture') busy.queue.push(apply); else apply();
}

function nameElement(f: Flight, element: HTMLElement | null | undefined, value: string, group?: string) {
  if (!element) return;
  element.style.setProperty('view-transition-name', value);
  if (group) element.style.setProperty('view-transition-class', group);
  f.named.add(element);
}
function unname(f: Flight) {
  for (const element of f.named) {
    element.style.removeProperty('view-transition-name');
    element.style.removeProperty('view-transition-class');
  }
  f.named.clear();
}

const rowTokens = new Map<string, number>();
/** Pane ids are arbitrary strings and a transition name must be an identifier. */
function rowToken(id: string) {
  let token = rowTokens.get(id);
  if (token === undefined) { token = rowTokens.size + 1; rowTokens.set(id, token); }
  return token;
}

/**
 * Names the panes, spines and dividers of the row as they stand. A pane and its spine share a name, so folding a pane
 * into its spine or revealing it from there moves one into the other; what only one state has enters or leaves.
 */
function nameRow(f: Flight) {
  for (const child of document.querySelectorAll<HTMLElement>('.panes > :is(.pane, .pane-spine, .pane-divider)')) {
    if (!child.getClientRects().length) {
      // A pane folded away keeps no name, so its spine can take it.
      child.style.removeProperty('view-transition-name');
      child.style.removeProperty('view-transition-class');
      continue;
    }
    const next = child.nextElementSibling;
    const id = child.dataset.pane ?? child.dataset.spine ?? (next instanceof HTMLElement ? next.dataset.pane : undefined);
    if (id !== undefined) nameElement(f, child, `${child.classList.contains('pane-divider') ? 'divider' : 'pane'}-${rowToken(id)}`, 'pane-row');
  }
}

/**
 * Holds the new state for `incoming`, the surface it shows, and marks the turn as its entry: a surface that lands
 * inside the turn, or the pane's own fade, adds none of its own. Resolves whether it is ready to be seen.
 */
async function hold(f: Flight, incoming: HTMLElement) {
  incoming.setAttribute('data-transition', '');
  f.marked.add(incoming);
  f.incoming = incoming;
  const ready = await settled(incoming, holdLimit) && !incoming.querySelector('[data-pane-loading]');
  if (flight !== f) return false;
  incoming.setAttribute('data-entered', '');
  f.ready = ready;
  return ready;
}

function release(f: Flight) {
  unname(f);
  for (const element of f.marked) element.removeAttribute('data-transition');
  f.marked.clear();
  if (f.lifted) {
    document.documentElement.style.removeProperty('--leaf-resume');
    document.documentElement.style.removeProperty('--leaf-lean');
  }
  if (flight === f) { flight = null; delete document.documentElement.dataset.paneDirection; }
}

/**
 * Where a turn that replaces one in mid-entry starts. A leaf drawn at `shown` opacity (0 to 1) still lies `1 - shown`
 * of the way back to the side it came from, positive from the right and negative from the left, because opacity and
 * travel share one easing. The turn lifts the old leaf away from there instead of from rest, which would pop it to
 * full first. Null once the leaf is at rest, or when none is entering.
 */
export function leafResume(shown: number | null | undefined, direction: Turn): { opacity: number; lean: number } | null {
  if (typeof shown !== 'number' || !Number.isFinite(shown) || shown >= 1) return null;
  const opacity = Math.max(0, shown);
  return { opacity, lean: (direction === 'back' ? -1 : 1) * (1 - opacity) };
}

/**
 * The opacity the leaf entering the page is drawn at, or null when none is entering. `getComputedTiming().progress`
 * is linear time: a CSS animation eases between its keyframes, so only the drawn style says where the leaf is.
 */
function leafShown(): number | null {
  const entering = document.getAnimations().some(animation => {
    const effect = animation.effect;
    return effect instanceof KeyframeEffect && effect.pseudoElement === '::view-transition-new(pane-leaf)' && !!(animation as CSSAnimation).animationName?.startsWith('leaf-in');
  });
  if (!entering) return null;
  const opacity = parseFloat(getComputedStyle(document.documentElement, '::view-transition-new(pane-leaf)').opacity);
  return Number.isFinite(opacity) ? opacity : null;
}

/** Hands the outgoing leaf its starting state through the two properties `leaf-out` begins from. */
function liftFrom(f: Flight, from: { opacity: number; lean: number }) {
  const style = document.documentElement.style;
  style.setProperty('--leaf-resume', from.opacity.toFixed(3));
  style.setProperty('--leaf-lean', from.lean.toFixed(3));
  f.lifted = true;
}

/** The transition ended. A surface still loading then fades in where it lands, the entry the turn did not give it. */
function finish(f: Flight) {
  if (flight !== f) return;
  if (f.incoming && !f.ready && waiting(f.incoming)) f.incoming.removeAttribute('data-entered');
  release(f);
}

/** Frees the names first, so the transition that replaces this one starts from a clean tree. */
function cancel(f: Flight) {
  release(f);
  f.transition?.skipTransition();
}

function transit(f: Flight, update: () => Promise<void>) {
  const transition = document.startViewTransition(async () => {
    f.phase = 'hold';
    for (const run of f.queue.splice(0)) run();
    if (flight === f) await update();
    f.phase = 'play';
  });
  f.transition = transition;
  // A skipped transition rejects `ready`; nothing waits on it.
  transition.ready.catch(() => {});
  const end = () => finish(f);
  void transition.finished.then(end, end);
}

/**
 * Applies a pane navigation as one leaf turning. The outgoing content stays on screen until the incoming surface
 * has something to show (no `data-pane-pending` left, up to `holdLimit`), then the old leaf lifts away and the new
 * one settles from the side it lies on: forward from the right, back from the left. A source cover visible on both
 * sides travels between them. A surface marked `data-pane-loading` needs animation frames to finish, which the held
 * transition never gives, so the leaf turns at once and that surface fades in when it lands.
 *
 * A pane that is not there yet (opening beside) enters as a leaf while the row of panes changes around it. The very
 * first pane has nothing to turn from and enters through the pane's own fade. A navigation that arrives while the
 * previous one is still taking its turn in the same pane folds into it; one that arrives once it is on screen
 * ends it and turns again. Without view transitions or with reduced motion the change applies at once.
 */
export function navigatePane(pane: string, direction: Turn, apply: () => void, sourceId?: string) {
  const outgoing = paneContent(pane);
  const plain = () => { outgoing?.removeAttribute('data-entered'); apply(); };
  const busy = flight;
  const plan = !canTransit() || !document.querySelector('section.pane') ? 'plain' : planTransition(busy, pane);
  if (busy && plan === 'fold') {
    busy.direction = direction;
    busy.sourceId = sourceId;
    document.documentElement.dataset.paneDirection = direction;
    join(busy, apply);
    return;
  }
  if (plan === 'plain') {
    if (busy && busy.phase !== 'play') join(busy, plain); else plain();
    return;
  }
  // A leaf caught mid-entry in this pane lifts away from where it is, not from rest, or it would pop to full first.
  const resume = busy && busy.pane === pane ? leafResume(leafShown(), busy.direction) : null;
  if (busy) cancel(busy);
  const f: Flight = { pane, direction, sourceId, phase: 'capture', queue: [apply], named: new Set(), marked: new Set(), ready: false };
  flight = f;
  document.documentElement.dataset.paneDirection = direction;
  if (outgoing?.getClientRects().length) {
    if (resume) liftFrom(f, resume);
    nameElement(f, outgoing, 'pane-leaf');
    nameElement(f, sourceId ? sourceCover(document, sourceId) : null, 'source-cover');
    transit(f, async () => {
      // The old state is captured; what the new state names is set below.
      unname(f);
      const incoming = paneContent(pane);
      if (!incoming) return;
      nameElement(f, incoming, 'pane-leaf');
      const ready = await hold(f, incoming);
      if (ready && f.sourceId) nameElement(f, sourceCover(incoming, f.sourceId), 'source-cover');
    });
  } else {
    // A pane that is not shown yet (new, or folded away) enters as the row changes around it.
    nameRow(f);
    transit(f, async () => {
      nameRow(f);
      const incoming = paneContent(pane);
      if (incoming) await hold(f, incoming);
    });
  }
}

/**
 * Changes the row of panes (closing, folding, revealing, resizing) as one transition: panes that stay glide to their
 * new place and width, a pane that leaves fades out, and a pane and its spine give way to one another. `apply` must
 * change the DOM synchronously; it runs a frame later, after the old row is captured.
 */
export function reflowPanes(apply: () => void) {
  const busy = flight;
  const plan = !canTransit() || !document.querySelector('.panes > .pane') ? 'plain' : planTransition(busy, null);
  if (plan === 'plain') {
    if (busy && busy.phase !== 'play') join(busy, apply); else apply();
    return;
  }
  if (busy) cancel(busy);
  const f: Flight = { pane: null, direction: 'forward', sourceId: undefined, phase: 'capture', queue: [apply], named: new Set(), marked: new Set(), ready: false };
  flight = f;
  nameRow(f);
  transit(f, async () => nameRow(f));
}

let swapping = false;

/**
 * Replaces what `panel` shows in one step: the old content fades out as the new fades in over `--motion-ui`, with
 * no blank or half-faded frame between them. `apply` must change the DOM synchronously; it runs a frame later,
 * after the old content is captured. When the swap changes which element is the panel (one pane tab for another),
 * `after` names the new one. During a page turn or another swap it applies at once instead.
 */
export function crossfade(panel: HTMLElement, apply: () => void, after?: () => HTMLElement | null) {
  if (!canTransit() || flight || swapping) { apply(); return; }
  swapping = true;
  panel.style.setProperty('view-transition-name', 'mode-panel');
  let next = panel;
  const transition = document.startViewTransition(() => {
    apply();
    const element = after?.();
    if (element && element !== panel) {
      panel.style.removeProperty('view-transition-name');
      element.style.setProperty('view-transition-name', 'mode-panel');
      next = element;
    }
  });
  const restore = () => { swapping = false; panel.style.removeProperty('view-transition-name'); next.style.removeProperty('view-transition-name'); };
  transition.ready.catch(() => {});
  void transition.finished.then(restore, restore);
}

/**
 * Moves `parts` from where they were to where `apply` lays them out, as one glide over `--motion-page`. `apply` may
 * change state that renders later in the same task; positions are read again before the next paint.
 */
export function glide(parts: () => readonly HTMLElement[], apply: () => void) {
  if (motionless()) { apply(); return; }
  const before = new Map<HTMLElement, DOMRect>();
  for (const part of parts()) before.set(part, part.getBoundingClientRect());
  apply();
  queueMicrotask(() => {
    const style = getComputedStyle(document.documentElement);
    const time = style.getPropertyValue('--motion-page').trim();
    const duration = parseFloat(time) * (time.endsWith('ms') ? 1 : 1000);
    if (!duration) return;
    const easing = style.getPropertyValue('--motion-ease').trim();
    for (const part of parts()) {
      const was = before.get(part);
      const now = part.getBoundingClientRect();
      // A part that appears or disappears has nowhere to glide from.
      if (!was || !was.width || !now.width) continue;
      const x = was.left - now.left, y = was.top - now.top;
      if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
      part.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }], { duration, easing });
    }
  });
}

/** Content enters on navigation; explicit mode panels fade in without remounting or delaying focus. */
export function createPaneMotion(content: Accessor<HTMLElement>, identity: Accessor<string>) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Set<Animation>();
  // Counts entries and cancellations, so an entry waiting for its surface knows when something else took over.
  let entry = 0;
  const stop = () => {
    entry++;
    for (const animation of animations) animation.cancel();
    animations.clear();
  };
  const animate = (element: HTMLElement, frames: Keyframe[], id: string, finished?: () => void): Animation | undefined => {
    if (reduced.matches) { finished?.(); return; }
    const style = getComputedStyle(content());
    const time = style.getPropertyValue('--motion-ui').trim();
    const duration = parseFloat(time) * (time.endsWith('ms') ? 1 : 1000);
    if (!duration) { finished?.(); return; }
    const animation = element.animate(frames, { duration, easing: style.getPropertyValue('--motion-ease').trim() });
    animation.id = id;
    animations.add(animation);
    const done = () => { animations.delete(animation); finished?.(); };
    animation.onfinish = done;
    animation.oncancel = done;
    return animation;
  };
  let previous: string | undefined;
  let pendingEntry = false;
  const enter = () => {
    const panel = content().firstElementChild;
    if (!pendingEntry || !(panel instanceof HTMLElement)) return;
    pendingEntry = false;
    // A view transition is presenting this navigation; a second fade would run on its captured leaf.
    if (reduced.matches || content().hasAttribute('data-transition')) return;
    // A surface still loading fades its own content in where it lands; fading the whole of it too would stack the two.
    if (content().querySelector('[data-pane-loading]')) return;
    const ticket = ++entry;
    const show = () => {
      const surface = content().firstElementChild;
      if (ticket !== entry || !(surface instanceof HTMLElement) || content().hasAttribute('data-transition')) return;
      // This is the entry: a surface that fades its own content in when it lands has nothing left to add.
      content().setAttribute('data-entered', '');
      const distance = getComputedStyle(content()).getPropertyValue('--motion-distance').trim();
      animate(surface, [{ opacity: 0, transform: `translateY(${distance})` }, { opacity: 1, transform: 'translateY(0)' }], 'pane-enter');
    };
    // A surface kept hidden while it loads has nothing to fade yet: the entry waits for it, which needs no frames.
    if (getComputedStyle(panel).visibility === 'hidden' && content().querySelector('[data-pane-pending]')) void settled(content(), entryLimit).then(show);
    else show();
  };
  createEffect(() => {
    const next = identity();
    if (next === previous) return;
    previous = next;
    stop();
    // Each navigation earns its own entry; the one before it no longer covers a surface landing late. A turn still on
    // screen is the entry of this one, though: taking its mark away would let a surface that lands inside it fade too.
    if (!content().hasAttribute('data-transition')) content().removeAttribute('data-entered');
    pendingEntry = true;
    queueMicrotask(enter);
  });
  onMount(() => {
    const element = content();
    const arrivals = new MutationObserver(enter);
    arrivals.observe(element, { childList: true });
    const typing = (event: InputEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.outline-pane')) return;
      pendingEntry = false;
      stop();
    };
    // A mode switch fades the new panel in. The old one is gone already; cloning it for a cross-fade cost a deep copy of large lists on every click.
    // The strip's own button changes the tab when this click reaches it, after this capturing listener has run (and
    // after any microtask queued from it), so the change is looked for just before the next frame is drawn. A strip
    // whose tab changes when a read lands (the Review queue) is watched for `modeWatchLimit` ms after that.
    let modeFrame = 0, modeTimer = 0, modeWatch: MutationObserver | undefined;
    const unwatch = () => { cancelAnimationFrame(modeFrame); clearTimeout(modeTimer); modeWatch?.disconnect(); modeWatch = undefined; };
    const click = (event: MouseEvent) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('.mode-tabs > button');
      const strip = button?.parentElement;
      const selector = strip?.dataset.modePanel;
      if (!button || !strip || !selector || button.disabled || event.shiftKey || event.metaKey || event.ctrlKey || reduced.matches || button.matches('[aria-pressed="true"], [aria-selected="true"]')) return;
      const selected = strip.querySelector('[aria-pressed="true"], [aria-selected="true"]');
      const changed = () => !strip.isConnected || strip.querySelector('[aria-pressed="true"], [aria-selected="true"]') !== selected;
      /** Fades the panel in once the tab has changed; true when this click is decided, either way. */
      const decide = () => {
        if (!element.isConnected) return true;
        if (!changed()) return false;
        // A tab that navigates or cross-fades has its own motion.
        if (flight || swapping) return true;
        const incoming = element.querySelector<HTMLElement>(selector);
        // A panel that holds its own strip would dim the tab just pressed.
        if (!incoming || incoming.contains(strip)) return true;
        stop();
        pendingEntry = false;
        animate(incoming, [{ opacity: 0 }, { opacity: 1 }], 'mode-enter');
        return true;
      };
      unwatch();
      modeFrame = requestAnimationFrame(() => {
        if (decide()) return;
        modeWatch = new MutationObserver(() => { if (decide()) unwatch(); });
        modeWatch.observe(strip, { subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected'] });
        modeTimer = window.setTimeout(unwatch, modeWatchLimit);
      });
    };
    // A pane's header holds tab strips too (Read, Outline, Compare), so the pane as a whole hears the click.
    const host = element.closest<HTMLElement>('section.pane') ?? element;
    host.addEventListener('click', click, true);
    reduced.addEventListener('change', stop);
    element.addEventListener('beforeinput', typing, true);
    onCleanup(() => { arrivals.disconnect(); pendingEntry = false; unwatch(); element.removeEventListener('beforeinput', typing, true); host.removeEventListener('click', click, true); reduced.removeEventListener('change', stop); stop(); });
  });
}
