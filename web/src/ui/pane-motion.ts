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
    case 'library': return `library:${target.tab ?? 'inbox'}`;
    case 'agenda': return `agenda:${target.mode ?? 'agenda'}:${target.date ?? ''}:${target.viewId ?? ''}`;
    case 'review': return `review:${target.deckId ?? ''}`;
    default: return target.kind;
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

/** How long a navigation holds the outgoing view for the incoming one to be ready. */
const holdLimit = 400;
let navigation: object | null = null;

/**
 * Applies a pane navigation as one leaf turning. The outgoing content stays on screen until the incoming surface
 * has something to show (no `data-pane-pending` left, up to `holdLimit`), then the old leaf lifts away and the new
 * one settles from the side it lies on: forward from the right, back from the left. A source cover visible on both
 * sides travels between them. A surface marked `data-pane-loading` needs animation frames to finish, which the held
 * transition never gives, so the leaf turns at once and that surface fades in when it lands. Without view
 * transitions or with reduced motion the change applies at once and the pane's own entry fade runs.
 */
export function navigatePane(pane: string, direction: 'forward' | 'back', apply: () => void, sourceId?: string) {
  const content = () => document.querySelector<HTMLElement>(`section.pane[data-pane="${CSS.escape(pane)}"] > .pane-content`);
  const start = document.startViewTransition?.bind(document);
  if (!start || window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.visibilityState !== 'visible') {
    content()?.removeAttribute('data-entered');
    apply();
    return;
  }
  const token = {};
  navigation = token;
  const name = `pane-${pane}`;
  const root = document.documentElement;
  const named = new Set<HTMLElement>();
  const nameElement = (element: HTMLElement | null | undefined, value: string) => {
    if (!element) return;
    element.style.setProperty('view-transition-name', value);
    named.add(element);
  };
  const clearNames = () => { for (const element of named) element.style.removeProperty('view-transition-name'); named.clear(); };
  const outgoing = content();
  nameElement(outgoing, name);
  nameElement(sourceId ? sourceCover(document, sourceId) : null, 'source-cover');
  root.dataset.paneDirection = direction;
  const transition = start(async () => {
    clearNames();
    content()?.setAttribute('data-transition', '');
    apply();
    const incoming = content();
    if (!incoming) return;
    nameElement(incoming, name);
    const ready = await settled(incoming, holdLimit) && !incoming.querySelector('[data-pane-loading]');
    // A surface shown ready by the transition skips its own entry fade; one still loading keeps it for when it lands.
    incoming.toggleAttribute('data-entered', ready);
    if (ready && sourceId) nameElement(sourceCover(incoming, sourceId), 'source-cover');
  });
  const finish = () => {
    clearNames();
    content()?.removeAttribute('data-transition');
    if (navigation === token) { navigation = null; delete root.dataset.paneDirection; }
  };
  void transition.finished.then(finish, finish);
}

/** Content enters on navigation; explicit mode panels fade in without remounting or delaying focus. */
export function createPaneMotion(content: Accessor<HTMLElement>, identity: Accessor<string>) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Set<Animation>();
  let waiting: (() => void) | null = null;
  const stop = () => {
    waiting?.();
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
    const distance = getComputedStyle(content()).getPropertyValue('--motion-distance').trim();
    animate(panel, [{ opacity: 0, transform: `translateY(${distance})` }, { opacity: 1, transform: 'translateY(0)' }], 'pane-enter');
  };
  createEffect(() => {
    const next = identity();
    if (next === previous) return;
    previous = next;
    stop();
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
    // A panel still showing the previous selection's rows marks itself aria-busy. It is held clear from the click and fades when its own rows
    // land, so neither stale rows nor a first render shows at full strength and then dips into the fade. A slow load shows after `holdLimit`.
    const click = (event: MouseEvent) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('.mode-tabs > button');
      const strip = button?.parentElement;
      const selector = strip?.dataset.modePanel;
      if (!button || !strip || !selector || button.disabled || event.shiftKey || event.metaKey || event.ctrlKey || reduced.matches || button.matches('[aria-pressed="true"], [aria-selected="true"]')) return;
      const selected = strip.querySelector('[aria-pressed="true"], [aria-selected="true"]');
      queueMicrotask(() => {
        if (!element.isConnected || strip.querySelector('[aria-pressed="true"], [aria-selected="true"]') === selected && strip.isConnected) return;
        const incoming = element.querySelector<HTMLElement>(selector);
        if (!incoming) return;
        stop();
        pendingEntry = false;
        const fade = animate(incoming, [{ opacity: 0 }, { opacity: 1 }], 'mode-enter');
        if (!fade || incoming.getAttribute('aria-busy') !== 'true') return;
        fade.pause();
        const observer = new MutationObserver(() => { if (incoming.getAttribute('aria-busy') !== 'true') release(); });
        const release = () => {
          observer.disconnect(); clearTimeout(timer);
          if (waiting === release) waiting = null;
          if (fade.playState === 'paused') fade.play();
        };
        const timer = setTimeout(release, holdLimit);
        waiting = release;
        observer.observe(incoming, { attributes: true, attributeFilter: ['aria-busy'] });
      });
    };
    element.addEventListener('click', click, true);
    reduced.addEventListener('change', stop);
    element.addEventListener('beforeinput', typing, true);
    onCleanup(() => { arrivals.disconnect(); pendingEntry = false; element.removeEventListener('beforeinput', typing, true); element.removeEventListener('click', click, true); reduced.removeEventListener('change', stop); stop(); });
  });
}
