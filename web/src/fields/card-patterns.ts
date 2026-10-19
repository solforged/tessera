import type { FieldDefinition } from '../api/types';

export interface PatternPart { text: string; field: boolean }

/** Preserve escaped opening braces verbatim so display and storage round-trip. */
export function patternParts(pattern: string): PatternPart[] {
  const parts: PatternPart[] = [];
  let start = 0;
  for (let at = 0; at < pattern.length; at++) {
    if (pattern[at] === '\\' && pattern[at + 1] === '{') { at++; continue; }
    if (pattern[at] !== '{') continue;
    const end = pattern.indexOf('}', at + 1);
    if (end < 0) throw new Error('Close the field reference with }.');
    if (at > start) parts.push({ text: pattern.slice(start, at), field: false });
    parts.push({ text: pattern.slice(at + 1, end), field: true });
    at = end; start = end + 1;
  }
  if (start < pattern.length) parts.push({ text: pattern.slice(start), field: false });
  return parts;
}

export function displayPattern(pattern: string, fields: readonly FieldDefinition[]): string {
  const names = new Map(fields.map(field => [field.id, field.name]));
  return patternParts(pattern).map(part => part.field ? `{${names.get(part.text) ?? part.text}}` : part.text).join('');
}

export function storedPattern(pattern: string, fields: readonly FieldDefinition[]): string {
  return patternParts(pattern).map(part => {
    if (!part.field) return part.text;
    if (part.text === '@text') return '{@text}';
    const exact = fields.find(field => field.id === part.text);
    const matches = exact ? [exact] : fields.filter(field => field.name === part.text);
    if (matches.length !== 1) throw new Error(matches.length ? `Choose one ${part.text} field from the picker.` : `Unknown field: ${part.text}`);
    return `{${matches[0]!.id}}`;
  }).join('');
}

export function usedFields(front: string, back: string): string[] {
  return [...new Set([...patternParts(front), ...patternParts(back)].filter(part => part.field && part.text !== '@text').map(part => part.text))];
}

/** Render the same reserved token and literal braces as the recipe evaluator. */
export function draftPattern(pattern: string, text: string, values: Readonly<Record<string, string>>): string | null {
  let missing = false;
  const result = patternParts(pattern).map(part => {
    if (!part.field) return part.text.replaceAll('\\{', '{');
    const value = part.text === '@text' ? text : values[part.text];
    if (!value?.trim()) missing = true;
    return value ?? '';
  }).join('');
  return missing || !result.trim() ? null : result;
}
