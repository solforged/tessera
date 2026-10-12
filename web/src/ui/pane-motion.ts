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

/** Content enters on navigation; explicit mode panels fade in without remounting or delaying focus. */
export function createPaneMotion(content: Accessor<HTMLElement>, identity: Accessor<string>) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Set<Animation>();
  const stop = () => {
    for (const animation of animations) animation.cancel();
    animations.clear();
  };
  const animate = (element: HTMLElement, frames: Keyframe[], id: string, finished?: () => void) => {
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
  };
  let previous: string | undefined;
  let pendingEntry = false;
  const enter = () => {
    const panel = content().firstElementChild;
    if (!pendingEntry || !(panel instanceof HTMLElement)) return;
    pendingEntry = false;
    if (reduced.matches) return;
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
        animate(incoming, [{ opacity: 0 }, { opacity: 1 }], 'mode-enter');
      });
    };
    element.addEventListener('click', click, true);
    reduced.addEventListener('change', stop);
    element.addEventListener('beforeinput', typing, true);
    onCleanup(() => { arrivals.disconnect(); pendingEntry = false; element.removeEventListener('beforeinput', typing, true); element.removeEventListener('click', click, true); reduced.removeEventListener('change', stop); stop(); });
  });
}
