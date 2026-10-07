import { textTokens } from '../document/text-tokens';

export interface TableSource { href: string; label: string; hostname: string }
export interface SourceText { sources: TableSource[]; remainder: string }

/** Recognise authored Markdown labels around URL tokens without changing stored text. */
function markdownLink(text: string, start: number, end: number): { start: number; end: number; hrefEnd: number; label: string } | undefined {
  const angled = text[start - 1] === '<';
  let opening = start - (angled ? 2 : 1);
  while (opening >= 0 && /\s/.test(text[opening]!)) opening--;
  if (text[opening] !== '(' || text[opening - 1] !== ']') return undefined;
  let depth = 1;
  let labelStart = opening - 2;
  for (; labelStart >= 0; labelStart--) {
    if (text[labelStart - 1] === '\\') continue;
    if (text[labelStart] === ']') depth++;
    else if (text[labelStart] === '[' && --depth === 0) break;
  }
  if (labelStart < 0 || text[labelStart - 1] === '!') return undefined;
  let hrefEnd = end;
  if (!angled) {
    let parentheses = 0;
    for (let index = start; index < end; index++) {
      if (text[index - 1] === '\\') continue;
      if (text[index] === '(') parentheses++;
      else if (text[index] === ')') {
        if (!parentheses) { hrefEnd = index; break; }
        parentheses--;
      }
    }
  }
  let closing = hrefEnd;
  if (angled) { if (text[closing] !== '>') return undefined; closing++; }
  while (/\s/.test(text[closing] ?? '') && closing < text.length) closing++;
  // A Markdown title is metadata, not an authored link label.
  if (text[closing] === '"' || text[closing] === "'") {
    const quote = text[closing++]!;
    while (closing < text.length && (text[closing] !== quote || text[closing - 1] === '\\')) closing++;
    if (text[closing] !== quote) return undefined;
    closing++;
    while (/\s/.test(text[closing] ?? '') && closing < text.length) closing++;
  }
  if (text[closing] !== ')') return undefined;
  return { start: labelStart, end: closing + 1, hrefEnd, label: text.slice(labelStart + 1, opening - 1).trim().replace(/\\([\[\]()\\])/g, '$1') };
}

/** Every original URL is retained, including repeated destinations with different labels. */
export function sourceText(text: string): SourceText {
  const sources: TableSource[] = [];
  const remainder: string[] = [];
  let offset = 0;
  const tokens = textTokens(text);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== 'url' || token.start < offset) continue;
    const markdown = markdownLink(text, token.start, token.end);
    const href = text.slice(token.start, markdown?.hrefEnd ?? token.end);
    // An ordinary source value can also be written as "Authored title: URL".
    const prefix = text.slice(0, token.start).trim();
    const labelled = !markdown && offset === 0 && !text.slice(token.end).trim() && prefix.endsWith(':') ? prefix.slice(0, -1).trim() : '';
    let hostname = '';
    let bareLabel = href;
    try {
      const url = new URL(href);
      hostname = url.hostname;
      bareLabel = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`;
    } catch { /* Invalid URL readings retain their original destination and warning. */ }
    sources.push({ href, label: markdown?.label || labelled || bareLabel, hostname });
    remainder.push(labelled ? '' : text.slice(offset, markdown?.start ?? token.start));
    offset = markdown?.end ?? token.end;
    // Adjacent Markdown links can share one URL token; revisit its unconsumed tail.
    if (markdown && markdown.end < token.end) tokens.splice(index + 1, 0, ...textTokens(text.slice(markdown.end, token.end)).map(part => ({ ...part, start: part.start + markdown.end, end: part.end + markdown.end })));
  }
  remainder.push(text.slice(offset));
  const remaining = remainder.join('').trim();
  return { sources, remainder: !sources.length ? text : /[\p{L}\p{N}]/u.test(remaining) ? remaining : '' };
}
