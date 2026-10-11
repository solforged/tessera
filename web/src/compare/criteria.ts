export interface ExactRepeat { number: number; criterion: string; text: string; positions: string[] }

/** Equality is only trimmed authored text, never a claim about agreement. Empty cells do not repeat. */
export function exactRepeats(criteria: readonly string[], positions: readonly string[], text: (position: string, criterion: string) => string): ExactRepeat[] {
  const repeats: ExactRepeat[] = [];
  for (const criterion of criteria) {
    const groups = new Map<string, string[]>();
    for (const position of positions) {
      const value = text(position, criterion).trim();
      if (!value) continue;
      const group = groups.get(value);
      if (group) group.push(position);
      else groups.set(value, [position]);
    }
    for (const [value, ids] of groups) if (ids.length > 1) repeats.push({ number: repeats.length + 1, criterion, text: value, positions: ids });
  }
  return repeats;
}
