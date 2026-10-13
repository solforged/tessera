import { textTokens } from '../document/text-tokens';

/** Only authored link occurrences count, in the same order as the position read. */
export function positionLinks(text: string) { return textTokens(text).filter(token => token.kind === 'reference'); }

export function changeHolderText(text: string, id: string, alias?: string): string {
  const first = positionLinks(text)[0];
  const token = `[[${id}${alias ? `|${alias}` : ''}]]`;
  return first ? text.slice(0, first.start) + token + text.slice(first.end) : `${token} ${text}`;
}

export function fileUnderText(text: string, id: string): string {
  const [first, second] = positionLinks(text);
  if (!first) throw new Error('Choose a holder before filing this perspective.');
  const token = `[[${id}]]`;
  return second ? text.slice(0, second.start) + token + text.slice(second.end) : text.slice(0, first.end) + ` ${token}` + text.slice(first.end);
}

export function usePlaceReason(text: string): string | undefined {
  const [first, second] = positionLinks(text);
  if (!first || !second) return 'This perspective already uses its place.';
  if (!/^ +$/.test(text.slice(first.end, second.start)) || second.end < text.length && !/\s/.test(text[second.end]!)) return 'The subject link is part of the prose. Remove it in the editor to use this place.';
  return undefined;
}

export function usePlaceText(text: string): string {
  const reason = usePlaceReason(text);
  if (reason) throw new Error(reason);
  const [first, second] = positionLinks(text);
  return text.slice(0, first!.end) + text.slice(second!.end);
}
