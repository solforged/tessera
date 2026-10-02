import { createEffect, createSignal, For, Show } from 'solid-js';
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
  key(item: T): string;
  row(item: T, selected: boolean): JSX.Element;
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
  const [selected, setSelected] = createSignal(0);
  let list!: HTMLDivElement;
  let input!: HTMLInputElement;
  createEffect(() => { props.items.length; props.query; setSelected(0); });
  createEffect(() => {
    selected(); props.items.length;
    queueMicrotask(() => {
      if (list?.isConnected) list.querySelector<HTMLElement>('.picker-row.selected')?.scrollIntoView({ block: 'nearest' });
    });
  });
  const current = () => props.items[selected()];
  const pick = (item: T, event: KeyboardEvent | MouseEvent) => {
    if (props.disabledReason?.(item)) return;
    props.onPick(item, event);
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
      <For each={props.items}>{(item, index) => {
        const reason = () => props.disabledReason?.(item);
        return <div role="option" aria-selected={index() === selected()} aria-disabled={!!reason()} title={reason()} class={`picker-row ${index() === selected() ? 'selected' : ''}`} onPointerMove={() => setSelected(index())} onClick={event => pick(item, event)}>
          {props.row(item, index() === selected())}
        </div>;
      }}</For>
      <Show when={!props.busy && !props.error && !props.items.length}><p class="empty-state">{props.empty}</p></Show>
    </div>
  </Popup>;
}
