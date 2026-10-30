import { Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { ListGroup } from '../ui/List';
import { isPhone } from '../ui/phone';

/**
 * One group of Settings rows. On a phone it is a ListGroup: the heading is the label above the leaf and the note is the
 * footnote under it. Elsewhere the rows keep the desktop layout, under the numbered head and the note's paragraph.
 * A group that only the phone splits off (Captures, the tiles) passes `label` and `footnote` instead.
 */
export function Group(props: { heading?: JSX.Element; note?: JSX.Element; label?: JSX.Element; footnote?: JSX.Element; children: JSX.Element }) {
  const phone = isPhone();
  return <Show when={phone} fallback={<>{props.heading}<Show when={props.note}><p class="settings-empty">{props.note}</p></Show>{props.children}</>}>
    <ListGroup label={props.label ?? props.heading} footnote={props.footnote ?? props.note} class="settings-group">{props.children}</ListGroup>
  </Show>;
}
