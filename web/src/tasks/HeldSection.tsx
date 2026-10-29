import { Show, createEffect, createMemo, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { exitRow, heldRows, releaseRow } from './row-motion';

/**
 * A task group (Overdue, an Upcoming day, Done) that stays mounted while one of its rows is still leaving, so the row can
 * fade and collapse in place. Once the group has no rows left, its head collapses with the last of them.
 */
export function HeldSection(props: { tag?: 'section' | 'div'; class?: string; 'aria-label'?: string; rows: readonly { source: { block: { id: string } } }[]; children: JSX.Element }) {
  let last = new Set<string>();
  const alive = createMemo(() => {
    const held = heldRows(), now = new Set(props.rows.map(row => row.source.block.id));
    const retained = [...last].filter(id => held.has(id));
    last = new Set([...now, ...retained]);
    return now.size > 0 || retained.length > 0;
  });
  let element: HTMLElement | undefined;
  const emptied = () => alive() && props.rows.length === 0;
  createEffect(() => {
    // Read first: on the first run the element is not set yet, and an early return would leave the effect tracking nothing.
    const collapse = emptied(), target = element;
    if (!target || !collapse) return;
    exitRow(target, 0, true);
    onCleanup(() => releaseRow(target));
  });
  const content = () => props.tag === 'div'
    ? <div ref={el => { element = el; }} class={props.class} aria-label={props['aria-label']}>{props.children}</div>
    : <section ref={el => { element = el; }} class={props.class} aria-label={props['aria-label']}>{props.children}</section>;
  return <Show when={alive()}>{content()}</Show>;
}
