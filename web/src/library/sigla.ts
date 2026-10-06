/** Assign display sigla in first-appearance order without renaming earlier sources. */
export function pageSigla(sources: readonly { id: string; siglum: string; basis: string }[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const source of sources) {
    if (result.has(source.id)) continue;
    let display = source.siglum;
    if (used.has(display)) {
      const basis = source.basis.toLowerCase();
      const start = Math.max(0, basis.indexOf(source.siglum.toLowerCase())) + source.siglum.length;
      for (const letter of basis.slice(start)) {
        display += letter;
        if (!used.has(display)) break;
      }
      if (used.has(display)) {
        const stem = display;
        let digit = 1;
        do { display = `${stem}${digit++}`; } while (used.has(display));
      }
    }
    result.set(source.id, display);
    used.add(display);
  }
  return result;
}
