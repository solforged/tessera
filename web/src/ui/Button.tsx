import { splitProps } from 'solid-js';
import type { JSX } from 'solid-js';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  label?: string;
  shortcut?: string;
}
export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ['icon', 'label', 'shortcut', 'children', 'class', 'classList', 'title']);
  // Solid's spread writes `class` after `classList` and drops its names, so both join one class string.
  const classes = () => ['button', local.class, local.icon && !local.children && 'icon-only', ...Object.entries(local.classList ?? {}).filter(([, on]) => on).map(([name]) => name)].filter(Boolean).join(' ');
  return <button type="button" {...rest} class={classes()} aria-label={props['aria-label'] ?? local.label} title={local.title ?? (local.label ? `${local.label}${local.shortcut ? ` (${local.shortcut})` : ''}` : undefined)}>
    {local.icon && <Icon name={local.icon} />}{local.children}
  </button>;
}
