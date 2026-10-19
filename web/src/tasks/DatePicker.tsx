import { createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, Show } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { MonthGrid } from '../ui/MonthGrid';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';
import { createMonthPlanningMarks } from './create-planning-marks';
import { parseTaskDate } from './date-input';
import { partialDatePlaceholder } from '../fields/kinds';
import { partialFieldDate } from '../fields/value-options';
import './date-picker.css';

export interface DatePickerProps {
  notebook: NotebookClient;
  anchor: PopupAnchor;
  label: string;
  value: string | null;
  /** A typed inline query can seed the input without becoming the calendar's selected date. */
  initialQuery?: string;
  /** Field dates may retain year or month precision; task dates always name a day. */
  partialDates?: boolean;
  presets?: 'revisit';
  /** Omit for date-only values; null enables an optional time. */
  time?: string | null;
  /** Only the Deadline editor supplies a warning lead. */
  warningDays?: number | null;
  contextDate: string;
  /** Related dates shown on the calendar, such as the deadline while scheduling. */
  marks?: Record<string, string>;
  onDismiss(): void;
  onSelect(value: { date: string | null; time: string | null; warning_days?: number | null }): void | Promise<void>;
  /** Field filling commits a valid draft before moving to the next or previous slot. */
  onAdvance?(backward: boolean): void;
}

export function DatePicker(props: DatePickerProps) {
  const id = createUniqueId();
  const [date, setDate] = createSignal(props.initialQuery ?? props.value ?? '');
  const [time, setTime] = createSignal(props.time ?? '');
  const [warning, setWarning] = createSignal(props.warningDays == null ? '' : String(props.warningDays));
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

  const select = async (value: { date: string | null; time: string | null }, backward?: boolean) => {
    if (busy()) return;
    const lead = warning().trim() ? Number(warning()) : null;
    if (props.warningDays !== undefined && lead !== null && (!/^\d+$/.test(warning()) || !Number.isSafeInteger(lead) || lead > 4_294_967_295)) { setError('Enter a nonnegative whole number of days.'); return; }
    setBusy(true);
    setError('');
    const draftDate = date();
    const draftTime = time();
    try {
      await props.onSelect({ ...value, ...(props.warningDays !== undefined ? { warning_days: value.date ? lead : null } : {}) });
      if (active) {
        props.onDismiss();
        if (backward !== undefined) props.onAdvance?.(backward);
      }
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
  const apply = (input = date(), backward?: boolean) => {
    if (busy()) return;
    const partial = props.partialDates ? partialFieldDate(input) : null;
    if (partial) { void select({ date: partial, time: null }, backward); return; }
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
      clock = timed.time;
    }
    void select({ date: parsed.date, time: clock }, backward);
  };
  const quickPick = (input: string) => {
    if (busy()) return;
    setDate(input);
    apply(input);
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Tab' && props.onAdvance && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      apply(date(), event.shiftKey);
      return;
    }
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement) || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.repeat) apply();
  };
  // The calendar follows whatever the field currently parses to, so typing `fri` previews the day.
  const preview = createMemo(() => {
    const partial = props.partialDates ? partialFieldDate(date()) : null;
    if (partial) return partial.includes('-') ? `${partial}-01` : `${partial.padStart(4, '0')}-01-01`;
    const parsed = parseTaskDate(date(), props.contextDate);
    return parsed.ok ? parsed.date : null;
  });
  const planning = props.presets === 'revisit' ? undefined : createMonthPlanningMarks(() => props.notebook, preview() ?? props.contextDate);

  return <Popup anchor={props.anchor} label={props.label} onDismiss={props.onDismiss} class="date-picker" fitContent>
    <form class="date-picker-form" aria-busy={busy()} onKeyDown={keydown} onCompositionStart={() => { composing = true; }} onCompositionEnd={() => { composing = false; }} onSubmit={event => { event.preventDefault(); if (!composing) apply(); }}>
      <div class="date-picker-body">
        <div class="date-picker-field">
          <label for={`${id}-date`}>{props.label}</label>
          <input id={`${id}-date`} class="input" type="text" value={date()} placeholder={props.partialDates ? partialDatePlaceholder : 'today, next Monday, +2d'} autocomplete="off" spellcheck={false} disabled={busy()} aria-invalid={!!error()} aria-describedby={error() ? `${id}-error` : undefined} onInput={event => {
            const value = event.currentTarget.value;
            setDate(value);
            if (props.time !== undefined) {
              const parsed = parseTaskDate(value, props.contextDate);
              if (parsed.ok && parsed.time !== null) setTime(parsed.time);
            }
          }} />
        </div>
        <div class="date-picker-quick-picks">
          <Show when={props.presets === 'revisit'} fallback={<>
            <Button disabled={busy()} onClick={() => quickPick('today')}>Today</Button>
            <Button disabled={busy()} onClick={() => quickPick('tomorrow')}>Tomorrow</Button>
            <Button disabled={busy()} onClick={() => quickPick('+1w')}>Next week</Button>
          </>}>
            <Button disabled={busy()} onClick={() => quickPick('+1w')}>Revisit in a week</Button>
            <Button disabled={busy()} onClick={() => quickPick('+1m')}>Revisit in a month</Button>
            <Button disabled={busy()} onClick={() => quickPick('+3m')}>Revisit in three months</Button>
          </Show>
        </div>
        <MonthGrid value={preview()} today={props.contextDate} marks={props.marks} planningMarks={planning?.marks()} planningLoading={planning?.loading()} planningError={planning?.error()} onMonthChange={planning?.setMonth} disabled={busy()} onPick={day => { setDate(day); apply(day); }} />
      </div>
      <div class="date-picker-footer">
        <Show when={props.time !== undefined}>
          <div class="date-picker-field">
            <label for={`${id}-time`}>Time (optional)</label>
            <input id={`${id}-time`} class="input date-picker-time" type="text" value={time()} placeholder="HH:MM" autocomplete="off" spellcheck={false} disabled={busy()} aria-invalid={!!error()} aria-describedby={error() ? `${id}-error` : undefined} onInput={event => {
              setTime(event.currentTarget.value);
              const parsed = parseTaskDate(date(), props.contextDate);
              if (parsed.ok && parsed.time !== null) setDate(parsed.date ?? '');
            }} />
          </div>
        </Show>
        <Show when={props.warningDays !== undefined}><label class="date-picker-field">Warning lead (days)<input class="input" inputmode="numeric" value={warning()} placeholder="None" disabled={busy()} onInput={event => setWarning(event.currentTarget.value)} /></label></Show>
        <Show when={error()}><p id={`${id}-error`} class="error date-picker-error" role="alert">{error()}</p></Show>
        <div class="date-picker-actions">
          <Button disabled={busy()} onClick={() => { void select({ date: null, time: null }); }}>{props.presets === 'revisit' ? 'No revisit date' : 'Clear'}</Button>
          <Button type="submit" class="bordered" disabled={busy()}>Apply</Button>
        </div>
      </div>
    </form>
  </Popup>;
}
