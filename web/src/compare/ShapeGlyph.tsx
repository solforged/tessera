import { Show } from 'solid-js';

/**
 * A small drawing of a `Shape::` value, so the compare table reads at a glance: a falling line, a closed
 * circle, an open arc for a cycle rarely completed, a spiral, or branches. Unknown shapes draw nothing.
 */
const shapes: [RegExp, string][] = [
  [/rarely|incomplete|broken|unfinished|open/, 'M16 4a8 8 0 1 0 7.5 5.2'],
  [/spiral/, 'M16 12a2 2 0 1 1-2-2 4 4 0 1 1-4 4 6 6 0 1 1 6 6 8 8 0 0 1-8-8'],
  [/branch|tree|many|direction/, 'M4 18h6 M10 18l8-10 M10 18l8 0 M10 18l8 7'],
  [/circle|cycle|loop/, 'M24 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z'],
  [/line|decline|descent|linear/, 'M3 5h6v5h6v5h6v5h6'],
];

export function ShapeGlyph(props: { value: string }) {
  const path = () => shapes.find(([pattern]) => pattern.test(props.value.toLowerCase()))?.[1];
  return <Show when={path()}>{d => <svg class="shape-glyph" viewBox="0 0 30 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={d()} /></svg>}</Show>;
}
