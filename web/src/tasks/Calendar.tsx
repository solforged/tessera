import { Show } from 'solid-js';
import type { WorkshopClient } from '../document/contract';
import { Button } from '../ui/Button';
import { isPhone } from '../ui/viewport';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';
import { Seg } from '../ui/Seg';
import { createMonthPlanningMarks } from './create-planning-marks';
import { createMonthDayCounts } from './month-day-counts';
import { MonthGrid } from './MonthGrid';
import { shiftCalendarDate } from './week-calendar';

type Quick = 'yesterday' | 'today' | 'tomorrow' | 'other';

/**
 * The journal's day picker. A phone gets a sheet, "Go to a day": the month with each day's open or overdue count and
 * Yesterday, Today and Tomorrow at its foot. Elsewhere it is a small popup with scheduled and deadline marks.
 */
export function Calendar(props: {
  workshop: WorkshopClient;
  anchor: PopupAnchor;
  label?: string;
  date: string;
  today: string;
  onToday(): void;
  onDismiss(): void;
  onSelect(date: string): void;
}) {
  const sheet = isPhone();
  const planning = sheet ? undefined : createMonthPlanningMarks(() => props.workshop, props.date);
  const counts = sheet
    ? createMonthDayCounts(
        () => props.workshop,
        props.date,
        () => props.today,
      )
    : undefined;
  const month = (planning ?? counts)!;
  const quick = (): Quick => {
    const offset = [-1, 0, 1].find(days => shiftCalendarDate(props.today, days) === props.date);
    return offset === undefined ? 'other' : (['yesterday', 'today', 'tomorrow'] as const)[offset + 1]!;
  };
  const go = (value: Quick) => {
    props.onDismiss();
    if (value === 'today') props.onToday();
    else if (value !== 'other') props.onSelect(shiftCalendarDate(props.today, value === 'yesterday' ? -1 : 1)!);
  };
  return (
    <Popup
      anchor={props.anchor}
      onDismiss={props.onDismiss}
      label={props.label ?? 'Choose journal date'}
      width={280}
      class="calendar-popup"
      placement={sheet ? 'sheet' : undefined}
      title={sheet ? 'Go to a day' : undefined}
    >
      <MonthGrid
        value={props.date}
        today={props.today}
        planningMarks={planning?.marks()}
        dayCounts={counts?.counts()}
        planningLoading={month.loading()}
        planningError={month.error()}
        onMonthChange={month.setMonth}
        onPick={date => {
          props.onDismiss();
          props.onSelect(date);
        }}
      />
      <Show
        when={sheet}
        fallback={
          <Button
            class="calendar-today"
            icon="calendar"
            onClick={() => {
              props.onDismiss();
              props.onToday();
            }}
          >
            Today
          </Button>
        }
      >
        <Seg<Quick>
          class="calendar-quick"
          label="Jump to"
          value={quick()}
          onChange={go}
          options={[
            { value: 'yesterday', label: 'Yesterday' },
            { value: 'today', label: 'Today' },
            { value: 'tomorrow', label: 'Tomorrow' },
          ]}
        />
      </Show>
    </Popup>
  );
}
