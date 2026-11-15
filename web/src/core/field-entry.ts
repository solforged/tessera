export function fieldEntryId(text: string): string | null {
  return /^\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/.exec(text)?.[1] ?? null;
}
