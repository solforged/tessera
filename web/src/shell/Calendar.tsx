import { Button } from '../ui/Button';
import { MonthGrid } from '../ui/MonthGrid';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';

export function Calendar(props: { anchor: PopupAnchor; date: string; today: string; onToday(): void; onDismiss(): void; onSelect(date: string): void }) {
  return <Popup anchor={props.anchor} onDismiss={props.onDismiss} label="Choose journal date" width={280} class="calendar-popup">
    <MonthGrid value={props.date} today={props.today} onPick={date => { props.onDismiss(); props.onSelect(date); }} />
    <Button class="calendar-today" icon="calendar" onClick={() => { props.onDismiss(); props.onToday(); }}>Today</Button>
  </Popup>;
}
