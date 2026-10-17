import { onCleanup, onMount } from 'solid-js';

const selectedTab = ':scope > .button:is([aria-pressed="true"], [aria-selected="true"])';

type StripRule = {
  rule: HTMLElement;
  buttons: Set<HTMLElement>;
  selected: HTMLElement | null;
  activated: HTMLElement | null;
  x: number;
  width: number;
};

/** One ruling pen follows the current tab; layout changes settle it without replaying the glide. */
export function installTabRule() {
  onMount(() => {
    const strips = new Map<HTMLElement, StripRule>();
    const owners = new WeakMap<Element, HTMLElement>();
    const dirty = new Set<HTMLElement>();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const update = (strip: HTMLElement) => {
      const state = strips.get(strip);
      if (!state) return;
      // A strip may hide overflowed tabs, pressed ones included, behind a pressed More; the pen follows the one on show.
      const selected = Array.from(strip.querySelectorAll<HTMLElement>(selectedTab)).find(element => element.getClientRects().length > 0);
      const bounds = selected?.getBoundingClientRect();
      if (!selected || !bounds?.width || !bounds.height) {
        state.rule.style.setProperty('--tab-rule-visible', '0');
        state.selected = null;
        state.activated = null;
        return;
      }
      const stripBounds = strip.getBoundingClientRect();
      // Content coordinates let the strip's own scrolling carry the rule, without a scroll listener.
      const x = bounds.left - stripBounds.left - strip.clientLeft + strip.scrollLeft;
      const width = bounds.width;
      if (selected !== state.selected || x !== state.x || width !== state.width) {
        // Restored defaults can arrive after mount; only an explicit tab activation moves the pen.
        const glide = state.selected !== null && state.selected !== selected && state.activated === selected && !reduced.matches;
        state.rule.style.setProperty('--tab-rule-duration', glide ? 'var(--motion-page)' : '0ms');
        state.rule.style.setProperty('--tab-rule-x', `${x}px`);
        state.rule.style.setProperty('--tab-rule-w', `${width}`);
        state.rule.style.setProperty('--tab-rule-visible', '1');
        if (selected !== state.selected) state.activated = null;
        state.selected = selected;
        state.x = x;
        state.width = width;
      }
    };
    const schedule = (strip: HTMLElement) => {
      dirty.add(strip);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        for (const strip of dirty) update(strip);
        dirty.clear();
      });
    };
    const resize = new ResizeObserver(entries => {
      for (const entry of entries) {
        const strip = owners.get(entry.target);
        if (strip) schedule(strip);
      }
    });
    const watchButtons = (strip: HTMLElement, state: StripRule) => {
      const buttons = new Set(strip.querySelectorAll<HTMLElement>(':scope > .button'));
      for (const button of state.buttons) if (!buttons.has(button)) resize.unobserve(button);
      for (const button of buttons) if (!state.buttons.has(button)) {
        owners.set(button, strip);
        resize.observe(button);
      }
      state.buttons = buttons;
    };
    const discover = (element: Element) => {
      const found = element.matches('.mode-tabs') ? [element] : [];
      found.push(...element.querySelectorAll('.mode-tabs'));
      for (const candidate of found) {
        if (!(candidate instanceof HTMLElement) || strips.has(candidate)) continue;
        const rule = document.createElement('span');
        rule.className = 'tab-rule';
        rule.setAttribute('aria-hidden', 'true');
        const state: StripRule = { rule, buttons: new Set(), selected: null, activated: null, x: 0, width: 0 };
        strips.set(candidate, state);
        owners.set(candidate, candidate);
        candidate.append(rule);
        resize.observe(candidate);
        watchButtons(candidate, state);
        update(candidate);
      }
    };
    const mutations = new MutationObserver(records => {
      let removed = false;
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        const strip = target?.closest<HTMLElement>('.mode-tabs');
        if (strip && strips.has(strip)) {
          if (record.type === 'childList') watchButtons(strip, strips.get(strip)!);
          schedule(strip);
        }
        if (record.type !== 'childList') continue;
        removed ||= record.removedNodes.length > 0;
        for (const node of record.addedNodes) if (node instanceof Element) discover(node);
      }
      if (removed) for (const [strip, state] of strips) if (!strip.isConnected) {
        resize.unobserve(strip);
        for (const button of state.buttons) resize.unobserve(button);
        state.rule.remove();
        strips.delete(strip);
        dirty.delete(strip);
      }
    });
    const activate = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>('.mode-tabs > .button') : null;
      const state = button?.parentElement && strips.get(button.parentElement);
      if (state) state.activated = button;
    };
    document.addEventListener('click', activate, true);
    discover(document.documentElement);
    mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected'] });
    onCleanup(() => {
      mutations.disconnect();
      document.removeEventListener('click', activate, true);
      resize.disconnect();
      cancelAnimationFrame(frame);
      for (const state of strips.values()) state.rule.remove();
    });
  });
}
