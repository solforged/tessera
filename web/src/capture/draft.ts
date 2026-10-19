import { textTokens } from '../document/text-tokens';
import { typeSpelling } from '../outline/type-completion';

/** Inputs show tag names, while the draft retains the identities chosen in completion. */
export function capturePresentation(source: string) {
  let text = '', offset = 0;
  const tags: { from: number; to: number; source: string }[] = [];
  for (const token of textTokens(source)) {
    if (token.kind !== 'tag' || !token.id) continue;
    text += source.slice(offset, token.start);
    const from = text.length;
    text += typeSpelling(token.value);
    tags.push({ from, to: text.length, source: source.slice(token.start, token.end) });
    offset = token.end;
  }
  return { text: text + source.slice(offset), tags };
}

/** Preserve only untouched, whole tag names; editing a name starts a fresh authored tag. */
export function editCaptureDraft(source: string, text: string): string {
  const previous = capturePresentation(source);
  if (previous.text === text) return source;
  let prefix = 0, suffix = 0;
  while (prefix < previous.text.length && prefix < text.length && previous.text[prefix] === text[prefix]) prefix++;
  while (suffix < previous.text.length - prefix && suffix < text.length - prefix && previous.text[previous.text.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
  const delta = text.length - previous.text.length;
  const tokens = textTokens(text);
  let result = '', offset = 0;
  for (const tag of previous.tags) {
    const shift = tag.to <= prefix ? 0 : tag.from >= previous.text.length - suffix ? delta : null;
    if (shift === null) continue;
    const from = tag.from + shift, to = tag.to + shift;
    if (!tokens.some(token => token.kind === 'tag' && token.start === from && token.end === to)) continue;
    result += text.slice(offset, from) + tag.source;
    offset = to;
  }
  return result + text.slice(offset);
}
