import { For } from 'solid-js';
import type { JSX } from 'solid-js';
import './seg.css';

export interface SegOption<T extends string> {
  value: T;
  label: JSX.Element;
}

/**
 * A choice among two to four settings (Sans or Serif, System, Light or Dark): the chosen segment is a leaf in a well and
 * nothing else marks it. It is 44 pt tall on a phone. A screen's views (List, Table, Fields) use the mode-tabs strip instead.
 */
export function Seg<T extends string>(props: {
  value: T;
  options: readonly SegOption<T>[];
  onChange(value: T): void;
  /** Names the choice for assistive technology, as a radio group. */
  label: string;
  class?: string;
}) {
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = props.options[(index + step + props.options.length) % props.options.length]!;
    props.onChange(next.value);
    (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[props.options.indexOf(next)]?.focus();
  };
  return <div class={`seg${props.class ? ` ${props.class}` : ''}`} role="radiogroup" aria-label={props.label}>
    <For each={props.options}>{(option, index) =>
      <button type="button" role="radio" aria-checked={props.value === option.value} tabIndex={props.value === option.value ? 0 : -1}
        onClick={() => props.onChange(option.value)} onKeyDown={event => move(event, index())}>{option.label}</button>}</For>
  </div>;
}
