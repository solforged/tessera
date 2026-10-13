import type { YearSpan } from '../api/types';

/** Mirrors the core historical reading for local problem feedback; stored text stays untouched. */
export function readSpan(written: string): YearSpan | null {
  const text = written.trim().replace(/^(?:c\.|ca\.|circa |fl\.)\s*/i, '');
  const bound = /^(b\.|d\.)\s*(.+)$/i.exec(text);
  if (bound) {
    const value = readSpan(bound[2]!);
    return value ? bound[1]!.toLowerCase() === 'b.' ? { from: value.from, through: null } : { from: null, through: value.through } : null;
  }
  const era = /\s*(BCE|BC|CE|AD)$/i.exec(text);
  const body = era ? text.slice(0, era.index).trim() : text;
  const inherited = era ? /^BC/i.test(era[1]!) : false;
  function endpoint(value: string): YearSpan | null {
    value = value.trim().replace(/^(?:c\.|ca\.|circa |fl\.)\s*/i, '');
    const ownEra = /\s*(BCE|BC|CE|AD)$/i.exec(value);
    const bce = ownEra ? /^BC/i.test(ownEra[1]!) : inherited;
    if (ownEra) value = value.slice(0, ownEra.index).trim();
    if (value === '?') return { from: null, through: null };
    const century = /^(\d+)(?:st|nd|rd|th)?\s+century$/i.exec(value);
    const decade = /^(\d+)s$/.exec(value);
    let from: number; let through: number;
    if (century) {
      const n = Number(century[1]);
      if (n < 1 || n > 100000) return null;
      from = (n - 1) * 100 + 1; through = n * 100;
    } else if (decade) {
      from = Number(decade[1]); through = from + 9;
      if (from < 1 || from > 9999990 || from % 10) return null;
    } else {
      if (!/^[+-]?\d+$/.test(value)) return null;
      from = through = Number(value);
      if (!from || Math.abs(from) > 9999999) return null;
    }
    if (bce && from < 0) return null;
    return bce ? { from: -through, through: -from } : { from, through };
  }
  const separator = /[–—]|(?<=.)-/.exec(body);
  const left = endpoint(separator ? body.slice(0, separator.index) : body);
  const right = separator ? endpoint(body.slice(separator.index + 1)) : left;
  if (!left || !right || left.from === null && right.through === null || left.from !== null && right.through !== null && left.from > right.through) return null;
  return { from: left.from, through: right.through };
}
