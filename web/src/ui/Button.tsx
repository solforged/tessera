import { splitProps } from 'solid-js';
import type { JSX } from 'solid-js';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  label?: string;
  shortcut?: string;
  /**
   * What the control is for. `stamp` is the screen's one gilt primary, `tint` a secondary (an ink-wash capsule on a
   * phone, a hairline leaf elsewhere) and `plain` a text action. Without it the button is plain text, as before.
   */
  kind?: 'stamp' | 'tint' | 'plain';
  /** `sm` is the inline 34 pt capsule on a phone; `lg` is the full-width 52 pt capsule at the foot of a screen. */
  size?: 'sm' | 'lg';
}
export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ['icon', 'label', 'shortcut', 'kind', 'size', 'children', 'class', 'classList', 'title']);
  // Solid's spread writes `class` after `classList` and drops its names, so both join one class string.
  const classes = () => ['button', local.kind, local.size, local.class, local.icon && !local.children && 'icon-only', ...Object.entries(local.classList ?? {}).filter(([, on]) => on).map(([name]) => name)].filter(Boolean).join(' ');
  return <button type="button" {...rest} class={classes()} aria-label={props['aria-label'] ?? local.label} title={local.title ?? (local.label ? `${local.label}${local.shortcut ? ` (${local.shortcut})` : ''}` : undefined)}>
    {local.icon && <Icon name={local.icon} />}{local.children}
  </button>;
}
