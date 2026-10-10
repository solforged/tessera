import { Show, type JSX } from 'solid-js';

import { paths, type Glyph, type IconName } from './glyphs';

export type { IconName };
export function Icon(props: { name: IconName; class?: string }): JSX.Element {
  const glyph = (): Glyph => paths[props.name];
  return <svg class={`icon ${props.class ?? ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={typeof glyph() === 'string' ? glyph() as string : glyph()[0]} />
    <Show when={typeof glyph() !== 'string' && glyph()[1]}>{fill => <path d={fill()} fill="currentColor" stroke="none" />}</Show>
  </svg>;
}
