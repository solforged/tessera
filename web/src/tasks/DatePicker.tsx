import { createEffect, createSignal, createUniqueId, on, onCleanup, Show } from 'solid-js';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';
import { parseTaskDate } from './date-input';
import './date-picker.css';

export interface DatePickerProps {
  anchor: PopupAnchor;
  label: string;
  value: string | null;
  /** Omit for date-only values; null enables an optional time. */
  time?: string | null;
  contextDate: string;
  onDismiss(): void;
  onSelect(value: { date: string | null; time: string | null }): void | Promise<void>;
}

export function DatePicker(props: DatePickerProps) {
  const id = createUniqueId();
  const [date, setDate] = createSignal(props.value ?? '');
  const [time, setTime] = createSignal(props.time ?? '');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let active = true;
  let composing = false;
  onCleanup(() => { active = false; });
  createEffect(on([() => props.value, () => props.time], ([value, clock]) => {
    setDate(value ?? '');
    setTime(clock ?? '');
    setError('');
  }, { defer: true }));

  const select = async (value: { date: string | null; time: string | null }) => {
    if (busy()) return;
    setBusy(true);
    setError('');
    const draftDate = date();
    const draftTime = time();
    try {
      await props.onSelect(value);
      if (active) props.onDismiss();
    } catch (reason) {
      if (active) {
        setDate(draftDate);
        setTime(draftTime);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (active) setBusy(false);
    }
  };
  const apply = (input = date()) => {
    if (busy()) return;
    const parsed = parseTaskDate(input, props.contextDate);
    if (!parsed.ok) { setError(parsed.error); return; }
    if (props.time === undefined && parsed.time !== null) {
      setError('This value accepts a date only. Remove the time.');
      return;
    }
    let clock = parsed.time;
    if (props.time !== undefined && time().trim()) {
      if (parsed.date === null) { setError('Enter a date before a time.'); return; }
      const timed = parseTaskDate(`${parsed.date} ${time().trim()}`, props.contextDate);
      if (!timed.ok) { setError(timed.error); return; }
      if (clock !== null && clock !== timed.time) { setError('Enter one time, in the date or time field.'); return; }
      clock = timed.time;
    }
    void select({ date: parsed.date, time: clock });
  };
  const quickPick = (input: string) => {
    if (busy()) return;
    setDate(input);
    apply(input);
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement) || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.repeat) apply();
  };

  return <Popup anchor={props.anchor} label={props.label} onDismiss={props.onDismiss} class="date-picker">
    <form class="date-picker-form" aria-busy={busy()} onKeyDown={keydown} onCompositionStart={() => { composing = true; }} onCompositionEnd={() => { composing = false; }} onSubmit={event => { event.preventDefault(); if (!composing) apply(); }}>
      <div class="date-picker-field">
        <label for={`${id}-date`}>{props.label}</label>
        <input id={`${id}-date`} class="input" type="text" value={date()} placeholder="today, next Monday, +2d" autocomplete="off" spellcheck={false} disabled={busy()} aria-invalid={!!error()} aria-describedby={error() ? `${id}-error` : undefined} onInput={event => setDate(event.currentTarget.value)} />
      </div>
      <Show when={props.time !== undefined}>
        <div class="date-picker-field">
          <label for={`${id}-time`}>Time (optional)</label>
          <input id={`${id}-time`} class="input date-picker-time" type="text" value={time()} placeholder="HH:MM" autocomplete="off" spellcheck={false} disabled={busy()} aria-invalid={!!error()} aria-describedby={error() ? `${id}-error` : undefined} onInput={event => setTime(event.currentTarget.value)} />
        </div>
      </Show>
      <div class="date-picker-quick-picks">
        <Button disabled={busy()} onClick={() => quickPick('today')}>Today</Button>
        <Button disabled={busy()} onClick={() => quickPick('tomorrow')}>Tomorrow</Button>
        <Button disabled={busy()} onClick={() => quickPick('+1w')}>Next week</Button>
      </div>
      <Show when={error()}><p id={`${id}-error`} class="error date-picker-error" role="alert">{error()}</p></Show>
      <div class="date-picker-actions">
        <Button disabled={busy()} onClick={() => { void select({ date: null, time: null }); }}>Clear</Button>
        <Button type="submit" class="bordered" disabled={busy()}>Apply</Button>
      </div>
    </form>
  </Popup>;
}
