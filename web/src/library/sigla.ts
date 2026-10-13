import type { SourceRecord } from '../api/types';

type SiglumSource = Pick<SourceRecord, 'block_id' | 'siglum' | 'siglum_basis' | 'siglum_authored' | 'siglum_disambiguation'>;

/** Assign display sigla in first-appearance order without renaming earlier sources. */
export function pageSigla(sources: readonly SiglumSource[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  const colliders = new Map<string, { years: Set<string>; initials: Set<string> }>();
  for (const source of sources) {
    if (result.has(source.block_id)) continue;
    const stem = source.siglum;
    const hints = source.siglum_disambiguation;
    const earlier = colliders.get(stem);
    let display = stem;
    if (!source.siglum_authored && used.has(display)) {
      if (hints) {
        // Only earlier sources can veto a distinguisher: a later addition must not rename them.
        if (hints.year && !earlier?.years.has(hints.year) && !used.has(`${stem}${hints.year}`)) {
          display = `${stem}${hints.year}`;
        } else if (hints.title_initial && !earlier?.initials.has(hints.title_initial) && !used.has(`${stem}${hints.title_initial}`)) {
          display = `${stem}${hints.title_initial}`;
        } else {
          let ordinal = 2;
          do { display = `${stem}${ordinal++}`; } while (used.has(display));
        }
      } else {
        // Authorless sources retain their editor/site/title extension rule.
        const basis = [...source.siglum_basis].filter(letter => /\p{L}/u.test(letter)).join('').toUpperCase();
        for (const letter of [...basis].slice([...stem].length)) {
          display += letter;
          if (!used.has(display)) break;
        }
        if (used.has(display)) {
          const basisStem = display;
          let ordinal = 2;
          do { display = `${basisStem}${ordinal++}`; } while (used.has(display));
        }
      }
    }
    result.set(source.block_id, display);
    used.add(display);
    if (hints) {
      const group = earlier ?? { years: new Set<string>(), initials: new Set<string>() };
      if (hints.year) group.years.add(hints.year);
      if (hints.title_initial) group.initials.add(hints.title_initial);
      colliders.set(stem, group);
    }
  }
  return result;
}

/** Page sigla also keyed by each cited reference, so a highlight named as a Work carries its source's mark. */
export function citedSigla(cited: readonly { id: string; source: SiglumSource | null }[]): Map<string, string> {
  const marks = pageSigla(cited.flatMap(row => row.source ? [row.source] : []));
  for (const row of cited) if (row.source && row.id !== row.source.block_id) marks.set(row.id, marks.get(row.source.block_id)!);
  return marks;
}
