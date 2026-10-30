import { For, Show } from 'solid-js';
import { Icon } from '../ui/Icon';
import { ListGroup, ListRow } from '../ui/List';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';
import { moveChoices, shortDay } from './reschedule';
import './task-row.css';

/**
 * The phone's Move to sheet: the task's own words for confirmation, then the days people move work to, each with its date.
 * The task's current day is gilt. Choosing a day applies it and closes the sheet; Pick a date hands over to the calendar.
 * A timed task keeps its time, and the footer says so.
 */
export function MoveToSheet(props: {
  anchor: PopupAnchor;
  /** The task's text. */
  title: string;
  /** The day the task is planned for. */
  current: string | null;
  /** Its time, kept by every choice. */
  time: string | null;
  today: string;
  onChoose(date: string): void;
  onPickDate(): void;
  onDismiss(): void;
}) {
  return <Popup anchor={props.anchor} label="Move to" title="Move to" placement="sheet" class="move-to" autofocus={false} onDismiss={props.onDismiss}>
    <p class="move-to-task">{props.title || 'Empty task'}</p>
    <ListGroup>
      <For each={moveChoices(props.today)}>{choice => {
        const current = () => props.current === choice.date;
        return <ListRow class={current() ? 'move-to-choice move-to-current' : 'move-to-choice'} value={shortDay(choice.date, props.today)} onClick={() => props.onChoose(choice.date)}>{choice.label}</ListRow>;
      }}</For>
      <ListRow class="move-to-choice" trailing={<Icon name="calendar" />} onClick={props.onPickDate}>Pick a date</ListRow>
    </ListGroup>
    <Show when={props.time}>{time => <p class="move-to-keeps"><Icon name="clock" />Keeps its time, <span class="move-to-time">{time()}</span></p>}</Show>
  </Popup>;
}
