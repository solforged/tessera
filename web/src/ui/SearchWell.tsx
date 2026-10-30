import { splitProps } from 'solid-js';
import type { JSX } from 'solid-js';
import { Icon } from './Icon';

export interface SearchWellProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'class' | 'type' | 'children'> {
  /** Names the field for assistive technology; the well shows only its placeholder. */
  label: string;
  /** Controls at the well's trailing end, such as a `Button icon="filter"`; they sit inside the capsule. */
  children?: JSX.Element;
  class?: string;
}

/**
 * The phone's one search and filter field: a capsule well with the search glyph inside, a gilt baseline on focus.
 * Without the component, `.search` on a label or div around a glyph and an input draws the same well.
 */
export function SearchWell(props: SearchWellProps) {
  const [local, rest] = splitProps(props, ['label', 'children', 'class']);
  return <label class={`search${local.class ? ` ${local.class}` : ''}`}>
    <Icon name="search" />
    <input enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck={false} {...rest} type="search" aria-label={local.label} />
    {local.children}
  </label>;
}
