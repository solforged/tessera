import { Show, splitProps } from 'solid-js';
import type { JSX } from 'solid-js';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import './list.css';

/**
 * The phone's one grammar for lists: a group label in Plex above a leaf of 48 pt rows, hairlines starting at the text,
 * a chevron on every row that pushes, and an optional footnote under the leaf. Rows are ListRow or PropertyRow.
 */
export function ListGroup(props: {
  /** Names the group, in sentence case, outside the leaf. */
  label?: JSX.Element;
  /** A plain action at the end of the label, such as a Button kind="plain" reading New view. */
  action?: JSX.Element;
  /** A sentence under the leaf, for what the group's rows have in common. */
  footnote?: JSX.Element;
  class?: string;
  children: JSX.Element;
}) {
  return <section class={`list-group${props.class ? ` ${props.class}` : ''}`}>
    <Show when={props.label || props.action}><header class="list-label"><span>{props.label}</span>{props.action}</header></Show>
    <div class="list-leaf leaf">{props.children}</div>
    <Show when={props.footnote}><p class="list-foot">{props.footnote}</p></Show>
  </section>;
}

export interface ListRowProps {
  /** A 20 px glyph at the start of the row; separators then start at the text, not under the glyph. */
  icon?: IconName;
  /** A leading figure that is not a glyph, such as a cover; it takes the glyph's place and the row's text starts after it. */
  lead?: JSX.Element;
  /** The row's text. Names of things (pages, works) are set in the display face with `name`. */
  children: JSX.Element;
  /** `thing` sets the text in Piazzolla, as the names of things are; `work` also italicises it. */
  name?: 'thing' | 'work';
  /** A second line under the text, muted. Keep its parts together with white-space: nowrap spans. */
  detail?: JSX.Element;
  /** A figure at the trailing end, in mono: a count. */
  count?: JSX.Element;
  /** A setting's current choice at the trailing end, in muted prose. */
  value?: JSX.Element;
  /** Anything else at the trailing end, such as a switch. */
  trailing?: JSX.Element;
  /** The row pushes another screen: it ends in a chevron and is a button. */
  push?: boolean;
  /** Makes the row a button. */
  onClick?(event: MouseEvent & { currentTarget: HTMLButtonElement }): void;
  /** Destructive rows are in the danger colour. */
  danger?: boolean;
  disabled?: boolean;
  class?: string;
  'aria-haspopup'?: JSX.HTMLAttributes<HTMLButtonElement>['aria-haspopup'];
  'aria-expanded'?: boolean;
  label?: string;
}

/** One row of a ListGroup. A button when it pushes or has an onClick, otherwise a plain row. */
export function ListRow(props: ListRowProps) {
  const [local, rest] = splitProps(props, ['icon', 'lead', 'children', 'name', 'detail', 'count', 'value', 'trailing', 'push', 'onClick', 'danger', 'disabled', 'class', 'label']);
  const body = () => <>
    <Show when={local.icon}>{icon => <Icon name={icon()} />}</Show>
    <Show when={local.lead}><span class="list-row-lead">{local.lead}</span></Show>
    <span class="list-row-text">
      <span class="list-row-label" classList={{ 'list-row-thing': local.name === 'thing' || local.name === 'work', 'list-row-work': local.name === 'work' }}>{local.children}</span>
      <Show when={local.detail}><span class="list-row-detail">{local.detail}</span></Show>
    </span>
    <Show when={local.value !== undefined}><span class="list-row-value">{local.value}</span></Show>
    <Show when={local.count !== undefined}><span class="list-row-count">{local.count}</span></Show>
    {local.trailing}
    <Show when={local.push}><span class="list-chev"><Icon name="right" /></span></Show>
  </>;
  const classes = () => `list-row${local.danger ? ' danger' : ''}${local.class ? ` ${local.class}` : ''}`;
  return <Show when={local.push || local.onClick} fallback={<div class={classes()}>{body()}</div>}>
    <button type="button" {...rest} class={classes()} aria-label={local.label} disabled={local.disabled} onClick={event => local.onClick?.(event)}>{body()}</button>
  </Show>;
}

/** A property row: the label at the left in muted prose, its value at the right, as a person's fields read. */
export function PropertyRow(props: {
  label: JSX.Element;
  /** The value; a row with an onClick is a button that edits it. */
  children?: JSX.Element;
  onClick?(event: MouseEvent & { currentTarget: HTMLButtonElement }): void;
  class?: string;
  /** Names the control when the row is a button. */
  'aria-label'?: string;
}) {
  const body = () => <>
    <span class="property-label">{props.label}</span>
    <span class="property-value">{props.children}</span>
  </>;
  const classes = () => `property-row${props.class ? ` ${props.class}` : ''}`;
  return <Show when={props.onClick} fallback={<div class={classes()}>{body()}</div>}>
    <button type="button" class={classes()} aria-label={props['aria-label']} onClick={event => props.onClick?.(event)}>{body()}</button>
  </Show>;
}
