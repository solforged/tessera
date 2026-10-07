import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { Popup } from './Popup';
import type { PopupAnchor, PopupPlacement } from './Popup';

export interface PickerProps<T> {
  anchor: PopupAnchor;
  placement?: PopupPlacement;
  label: string;
  width?: number;
  class?: string;
  onDismiss(): void;
  query: string;
  onQuery(value: string): void;
  placeholder: string;
  /** Shown before the input, such as a mode chip. */
  prefix?: JSX.Element;
  /** Shown between the input and the rows, such as a scope bar. */
  status?: JSX.Element;
  items: T[];
  initial?: number;
  key(item: T): string;
  row(item: T, selected: boolean): JSX.Element;
  /** Headings for contiguous item groups; item order and keyboard indices stay unchanged. */
  section?(item: T): string | undefined;
  disabledReason?(item: T): string | undefined;
  onPick(item: T, event: KeyboardEvent | MouseEvent): void;
  /** Extra keys on the highlighted item; return true when handled. */
  onKey?(event: KeyboardEvent, item: T | undefined): boolean;
  busy?: boolean;
  error?: string;
  empty: string;
}

/** Input on top, rows below. Arrows move, Enter picks, typing filters. */
export function Picker<T>(props: PickerProps<T>) {
  const [selected, setSelected] = createSignal(props.initial ?? 0);
  let list!: HTMLDivElement;
  let input!: HTMLInputElement;
  let opening = true, firstScroll = true;
  createEffect(() => {
    const count = props.items.length; props.query;
    setSelected(opening ? Math.max(0, Math.min(props.initial ?? 0, count - 1)) : 0);
    opening = false;
  });
  createEffect(() => {
    selected(); props.items.length;
    const center = firstScroll && props.initial !== undefined;
    firstScroll = false;
    const reveal = () => {
      if (list?.isConnected) list.querySelector<HTMLElement>('.picker-row.selected')?.scrollIntoView({ block: center ? 'center' : 'nearest' });
    };
    if (center) requestAnimationFrame(reveal);
    else queueMicrotask(reveal);
  });
  const current = () => props.items[selected()];
  const pick = (item: T, event: KeyboardEvent | MouseEvent) => {
    if (props.disabledReason?.(item)) return;
    props.onPick(item, event);
  };
  const groups = createMemo(() => {
    const section = props.section;
    const result: { section: string | undefined; start: number; items: T[] }[] = [];
    if (!section) return result;
    props.items.forEach((item, index) => {
      const label = section(item);
      const previous = result.at(-1);
      if (previous && previous.section === label) previous.items.push(item);
      else result.push({ section: label, start: index, items: [item] });
    });
    return result;
  });
  const row = (item: T, index: () => number) => {
    const reason = () => props.disabledReason?.(item);
    return <div role="option" aria-selected={index() === selected()} aria-disabled={!!reason()} aria-description={reason()} title={reason()} class={`picker-row ${index() === selected() ? 'selected' : ''}`} onPointerMove={() => setSelected(index())} onClick={event => pick(item, event)}>
      {props.row(item, index() === selected())}
    </div>;
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const count = props.items.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected(index => count ? (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count : 0);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); setSelected(event.key === 'Home' ? 0 : Math.max(0, count - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault(); const item = current(); if (item !== undefined) pick(item, event);
    } else if (props.onKey?.(event, current())) {
      event.preventDefault();
      queueMicrotask(() => { if (input.isConnected) input.focus({ preventScroll: true }); });
    }
  };
  return <Popup anchor={props.anchor} placement={props.placement} onDismiss={props.onDismiss} label={props.label} width={props.width ?? 560} class={`picker ${props.class ?? ''}`}>
    <div class="picker-query" onKeyDown={keydown}>
      {props.prefix}
      <input ref={input} class="picker-input" aria-label={props.label} placeholder={props.placeholder} value={props.query} onInput={event => props.onQuery(event.currentTarget.value)} />
    </div>
    {props.status}
    <div ref={list} class="picker-list" role="listbox" aria-label={props.label}>
      <Show when={props.error}><p class="error" role="alert">{props.error}</p></Show>
      <Show when={props.busy}><p class="empty-state">Loading…</p></Show>
      <Show when={props.section} fallback={<For each={props.items}>{row}</For>}>
        <For each={groups()}>{group =>
          <Show when={group.section !== undefined} fallback={<For each={group.items}>{(item, index) => row(item, () => group.start + index())}</For>}>
            <div class="picker-group" role="group" aria-label={group.section}>
              <div class="picker-section" aria-hidden="true">{group.section}</div>
              <For each={group.items}>{(item, index) => row(item, () => group.start + index())}</For>
            </div>
          </Show>
        }</For>
      </Show>
      <Show when={!props.busy && !props.error && !props.items.length}><p class="empty-state">{props.empty}</p></Show>
    </div>
  </Popup>;
}
