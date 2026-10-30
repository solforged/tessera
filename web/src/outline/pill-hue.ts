import { foldName } from './names';

/** A pill's hue: one of the five type hues, chosen from the folded name so a tag keeps its colour wherever it appears. */
export function typeHue(name: string): string {
  let hash = 0;
  for (const character of foldName(name)) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return `var(--type-${hash % 5 + 1})`;
}
