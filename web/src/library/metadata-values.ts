import type { SourceFieldValue } from './details';

export const metadataText = (value: SourceFieldValue): string => typeof value === 'string' ? value : value.map(item => typeof item === 'string' ? item : item.name).join('\n');
export const metadataEqual = (a: SourceFieldValue, b: SourceFieldValue): boolean => JSON.stringify(a) === JSON.stringify(b);

export function metadataValues(values: readonly SourceFieldValue[]) {
  const distinct = new Map<string, { value: SourceFieldValue; count: number }>();
  let empty = 0;
  for (const value of values) {
    if (!metadataText(value).trim()) { empty++; continue; }
    const key = JSON.stringify(value);
    const previous = distinct.get(key);
    if (previous) previous.count++;
    else distinct.set(key, { value, count: 1 });
  }
  return { distinct: [...distinct.values()], empty, mixed: distinct.size > 1 || distinct.size === 1 && empty > 0 };
}
