import { createMemo, createSignal, For } from 'solid-js';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';

/** Calendar dates are local dates, never UTC slices. */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function Calendar(props: { anchor: PopupAnchor; date: string; onDismiss(): void; onSelect(date: string): void }) {
  const [month, setMonth] = createSignal(new Date(`${props.date}T12:00:00`));
  const cells = createMemo(() => {
    const value = month();
    const first = new Date(value.getFullYear(), value.getMonth(), 1, 12);
    const start = new Date(first); start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, index) => { const day = new Date(start); day.setDate(start.getDate() + index); return day; });
  });
  const move = (amount: number) => setMonth(value => new Date(value.getFullYear(), value.getMonth() + amount, 1, 12));
  return <Popup anchor={props.anchor} onDismiss={props.onDismiss} label="Choose journal date" width={280} class="calendar-popup">
    <div class="calendar-header"><Button icon="left" label="Previous month" onClick={() => move(-1)} /><strong>{month().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong><Button icon="right" label="Next month" onClick={() => move(1)} /></div>
    <div class="calendar-grid"><For each={['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']}>{day => <span class="weekday">{day}</span>}</For>
      <For each={cells()}>{day => <button type="button" class={`calendar-day ${day.getMonth() !== month().getMonth() ? 'outside-month' : ''} ${localDate(day) === props.date ? 'selected' : ''}`} aria-label={day.toLocaleDateString(undefined, { dateStyle: 'full' })} aria-current={localDate(day) === localDate(new Date()) ? 'date' : undefined} onClick={() => { props.onDismiss(); props.onSelect(localDate(day)); }}>{day.getDate()}</button>}</For>
    </div>
    <Button class="calendar-today" icon="calendar" onClick={() => { props.onDismiss(); props.onSelect(localDate(new Date())); }}>Today</Button>
  </Popup>;
}
