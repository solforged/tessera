import { createComputed, createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { Popup } from './Popup';
import type { PopupAnchor, PopupPlacement } from './Popup';

export interface PickerProps<T> {
  anchor: PopupAnchor;
  placement?: PopupPlacement;
  /** Measure the natural height before placing a flex picker with an internally scrolling list. */
  fitContent?: boolean;
  /** False leaves the query field unfocused, so a touch screen opens the list without the keyboard. */
  autofocus?: boolean;
  label: string;
  width?: number;
  class?: string;
  style?: JSX.CSSProperties;
  onDismiss(): void;
  query: string;
  onQuery(value: string): void;
  placeholder: string;
  inputRef?(input: HTMLInputElement): void;
  /** Shown before the input, such as a mode chip. */
  prefix?: JSX.Element;
  /** Controls after the input; omitted by ordinary pickers. */
  queryActions?: JSX.Element;
  /** Optional second column, driven by onSelect. */
  preview?: JSX.Element;
  onSelect?(item: T | undefined): void;
  /** Shown between the input and the rows, such as a scope bar. */
  status?: JSX.Element;
  items: T[];
  initial?: number;
  key(item: T): string;
  /** Persisted selection, distinct from the keyboard cursor. */
  isCurrent?(item: T): boolean;
  row(item: T, selected: boolean): JSX.Element;
  /** Headings for contiguous item groups; item order and keyboard indices stay unchanged. */
  section?(item: T): string | undefined;
  disabledReason?(item: T): string | undefined;
  onPick(item: T, event: KeyboardEvent | MouseEvent): void;
  /** Preserve an explicit Enter while the current query has no ready selection. */
  onPendingPick?(event: KeyboardEvent): void;
  /** Extra keys on the highlighted item; return true when handled. */
  onKey?(event: KeyboardEvent, item: T | undefined): boolean;
  /** Results are loading. Rows already shown stay, dimmed, until fresh ones arrive, and Enter waits through onPendingPick. */
  busy?: boolean;
  /** Holds the popup unplaced. By default it waits for the first moment the picker is not loading, so a list that arrives late is placed once, at its size. */
  ready?: boolean;
  /** Where focus goes when the picker closes, for an opener that is replaced or re-rendered while it is open. */
  returnFocus?: HTMLElement | (() => HTMLElement | null);
  error?: string;
  empty: string;
}

interface Group<T> { section: string | undefined; start: number; items: T[] }
/** Elements that take the keys and presses they are given; the picker's list keys and focus rescue leave them alone. */
const OWN_INPUT = 'button, a[href], input, textarea, select, summary, [contenteditable]:not([contenteditable="false"])';

/** Input on top, rows below. Arrows and PageUp/PageDown move, Enter picks, typing filters. */
export function Picker<T>(props: PickerProps<T>) {
  const id = createUniqueId();
  const listId = `${id}-list`;
  // The cursor is the key of the row it rests on, so it stays on that row as the list refreshes around it; none means the top.
  const [cursor, setCursor] = createSignal<string>();
  const [revealRevision, setRevealRevision] = createSignal(0);
  let list!: HTMLDivElement;
  let input!: HTMLInputElement;
  let opening = true, firstScroll = true, previousQuery = props.query;
  const settledNow = () => !props.busy || props.items.length > 0 || !!props.error;
  const initiallySettled = settledNow();
  const [settled, setSettled] = createSignal(initiallySettled);
  createComputed(() => { if (!settled() && settledNow()) setSettled(true); });
  const sections = (items: T[]) => {
    const section = props.section;
    const result: Group<T>[] = [];
    if (!section) return result;
    items.forEach((item, index) => {
      const label = section(item);
      const previous = result.at(-1);
      if (previous && previous.section === label) previous.items.push(item);
      else result.push({ section: label, start: index, items: [item] });
    });
    return result;
  };
  // A caller that clears its rows to load the next ones keeps the picker from blanking: the rows shown stay, with the
  // headings they were drawn under, until real rows replace them.
  const shown = createMemo<{ items: T[]; groups: Group<T>[] }>(previous => {
    const items = props.items;
    return props.busy && !items.length && previous.items.length ? previous : { items, groups: sections(items) };
  }, { items: [], groups: [] });
  const stale = createMemo(() => !!props.busy && !props.items.length && shown().items.length > 0);
  const selected = createMemo(() => {
    const key = cursor();
    const at = key === undefined ? 0 : shown().items.findIndex(item => props.key(item) === key);
    return Math.max(0, at);
  });
  const move = (index: number) => {
    const items = shown().items;
    const item = items[Math.max(0, Math.min(index, items.length - 1))];
    if (item !== undefined) setCursor(props.key(item));
  };
  createComputed(() => {
    const items = shown().items, query = props.query;
    if (query !== previousQuery) {
      // A new query starts at its first result.
      previousQuery = query; opening = false;
      setCursor(undefined); setRevealRevision(value => value + 1);
    } else if (opening && items.length) {
      opening = false;
      const at = Math.max(0, Math.min(props.initial ?? 0, items.length - 1));
      setCursor(at > 0 ? props.key(items[at]!) : undefined); setRevealRevision(value => value + 1);
    }
  });
  createEffect(() => {
    const at = selected(); revealRevision();
    const center = firstScroll && props.initial !== undefined;
    firstScroll = false;
    const reveal = () => {
      const row = list?.isConnected ? list.querySelector<HTMLElement>('.picker-row.selected') : null;
      if (!row) return;
      if (center) { row.scrollIntoView({ block: 'center' }); return; }
      // The first row comes back with whatever stands above it, and a group's first row with its heading.
      if (at === 0) list.scrollTop = 0;
      const heading = row.previousElementSibling;
      if (heading?.classList.contains('picker-section')) heading.scrollIntoView({ block: 'nearest' });
      row.scrollIntoView({ block: 'nearest' });
    };
    if (center) requestAnimationFrame(reveal);
    else queueMicrotask(reveal);
  });
  const current = () => shown().items[selected()];
  createEffect(() => props.onSelect?.(current()));
  const pick = (item: T, event: KeyboardEvent | MouseEvent) => {
    if (props.disabledReason?.(item)) return;
    props.onPick(item, event);
  };
  const row = (item: T, index: () => number) => {
    const reason = () => props.disabledReason?.(item);
    return <div id={`${id}-${index()}`} role="option" aria-selected={props.isCurrent ? props.isCurrent(item) : index() === selected()} aria-disabled={!!reason()} aria-description={reason()} title={reason()} class={`picker-row ${index() === selected() ? 'selected' : ''}`} onPointerMove={() => setCursor(props.key(item))} onClick={event => pick(item, event)}>
      {props.row(item, index() === selected())}
    </div>;
  };
  // A page of rows from the cursor, keeping one row of overlap; rows taller than the list still move by one.
  const page = (direction: 1 | -1) => {
    const rows = list.querySelectorAll<HTMLElement>('.picker-row');
    const from = rows[selected()];
    if (!from) return;
    const top = from.getBoundingClientRect().top, reach = Math.max(from.offsetHeight, list.clientHeight - from.offsetHeight);
    let at = selected();
    for (let next = at + direction; next >= 0 && next < rows.length && Math.abs(rows[next]!.getBoundingClientRect().top - top) <= reach; next += direction) at = next;
    move(at === selected() ? at + direction : at);
  };
  // Keys are taken at the popup's root, so a click that lands on a gap, heading or row cannot strand them.
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;
    const target = event.target;
    if (target !== input && target instanceof Element && target.closest(OWN_INPUT)) return;
    const count = shown().items.length;
    const modified = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(count ? (selected() + (event.key === 'ArrowDown' ? 1 : -1) + count) % count : 0);
    } else if ((event.key === 'PageDown' || event.key === 'PageUp') && !modified) {
      event.preventDefault(); page(event.key === 'PageDown' ? 1 : -1);
    } else if ((event.key === 'Home' || event.key === 'End') && (target === input ? (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey : !modified)) {
      // Home and End edit the query's caret; with Ctrl or Cmd they jump the list.
      event.preventDefault(); move(event.key === 'Home' ? 0 : count - 1);
    } else if (event.key === 'Enter') {
      // Rows left over from the previous query are not a selection for this one.
      event.preventDefault(); const item = stale() ? undefined : current(); if (item !== undefined) pick(item, event); else props.onPendingPick?.(event);
    } else if (props.onKey?.(event, stale() ? undefined : current())) {
      event.preventDefault();
      queueMicrotask(() => { if (input.isConnected) input.focus({ preventScroll: true }); });
    }
  };
  // A press on the list, a gap or a heading must not take focus from the query; a press elsewhere that does leaves it to be
  // given back on the click, unless it is selecting text or the query was not focused to begin with (touch).
  let inputHadFocus = false;
  const mousedown = (event: MouseEvent) => {
    inputHadFocus = document.activeElement === input;
    const target = event.target;
    if (event.button !== 0 || !(target instanceof Element) || target.closest(OWN_INPUT) || !(list.contains(target) || target.closest('.picker-query') || target === list.parentElement)) return;
    event.preventDefault();
  };
  const click = () => {
    // The popup's own box takes focus from a press on any part of it that is not focusable.
    const active = document.activeElement;
    if (!inputHadFocus || !input.isConnected || active && active !== document.body && active !== list.parentElement) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    input.focus({ preventScroll: true });
  };
  onMount(() => {
    const panel = list.parentElement;
    if (!panel) return;
    panel.addEventListener('keydown', keydown);
    panel.addEventListener('mousedown', mousedown);
    panel.addEventListener('click', click);
    onCleanup(() => {
      panel.removeEventListener('keydown', keydown);
      panel.removeEventListener('mousedown', mousedown);
      panel.removeEventListener('click', click);
    });
  });
  return <Popup anchor={props.anchor} placement={props.placement} fitContent={props.fitContent} autofocus={props.autofocus} ready={props.ready ?? (initiallySettled ? undefined : settled())} returnFocus={props.returnFocus} onDismiss={props.onDismiss} label={props.label} width={props.width ?? 560} class={`picker ${props.class ?? ''}`} style={props.style}>
    <div class="picker-query">
      {props.prefix}
      <input ref={element => { input = element; props.inputRef?.(element); }} class="picker-input" role="combobox" aria-expanded="true" aria-haspopup="listbox" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={shown().items.length ? `${id}-${selected()}` : undefined} aria-label={props.label} placeholder={props.placeholder} value={props.query} onInput={event => props.onQuery(event.currentTarget.value)} />
      {props.queryActions}
      <span class="visually-hidden" role="status">{props.busy ? 'Loading…' : ''}</span>
    </div>
    {props.status}
    <div ref={list} id={listId} class="picker-list" role="listbox" aria-label={props.label} aria-busy={props.busy || undefined} data-stale={stale() ? '' : undefined}>
      <Show when={props.error}><p class="error" role="alert">{props.error}</p></Show>
      {/* Rows stay put while loading; the wait is a line along the list's top edge, and only an empty list says it in words. */}
      <Show when={props.busy && !shown().items.length}><p class="empty-state">Loading…</p></Show>
      <Show when={props.section} fallback={<For each={shown().items}>{row}</For>}>
        <For each={shown().groups}>{group =>
          <Show when={group.section !== undefined} fallback={<For each={group.items}>{(item, index) => row(item, () => group.start + index())}</For>}>
            <div class="picker-group" role="group" aria-label={group.section}>
              <div class="picker-section" aria-hidden="true">{group.section}</div>
              <For each={group.items}>{(item, index) => row(item, () => group.start + index())}</For>
            </div>
          </Show>
        }</For>
      </Show>
      <Show when={!props.busy && !props.error && !shown().items.length}><p class="empty-state">{props.empty}</p></Show>
    </div>
    {props.preview}
  </Popup>;
}
