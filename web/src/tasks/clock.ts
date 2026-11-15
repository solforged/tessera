import { createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { WorkshopClient } from '../document/contract';

/** The workshop's wall clock as `HH:MM` in its time zone, ticking each minute, for comparing with task times. */
export function createClock(workshop: WorkshopClient): Accessor<string> {
  const read = () =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: workshop.settings()?.time_zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date());
  const [tick, setTick] = createSignal(0);
  const timer = window.setInterval(() => setTick(value => value + 1), 30_000);
  onCleanup(() => clearInterval(timer));
  return () => {
    tick();
    return read();
  };
}
