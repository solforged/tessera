import type { TaskState } from '../api/types';
import type { BlockClipboard, PasteRow } from './contract';
import { quoteTarget, textTokens } from './text-tokens';

export const BLOCK_CLIPBOARD_MIME = 'application/x-tessera-blocks+json';

export function clipboardText(content: BlockClipboard, tagTitle: (id: string) => string | null | undefined = () => undefined): string {
  function plainText(text: string): string {
    return textTokens(text).map(token => {
      if (token.kind !== 'tag') return text.slice(token.start, token.end);
      const title = (token.id ? tagTitle(token.id) : undefined) || token.alias || token.value || token.id || '';
      return /^[\p{L}\p{M}\p{N}_/-]+$/u.test(title) ? `#${title}` : `#[[${title}]]`;
    }).join('');
  }
  return content.blocks.map(({ block, depth, capabilities }) => {
    if (capabilities.image) return '  '.repeat(depth) + (plainText(block.text) || 'Image');
    const quote = capabilities.quote;
    if (quote && quoteTarget(block.text) === quote.target_id) {
      return quote.rows.flatMap(row => plainText(row.text).split('\n').map((line, index) =>
        '  '.repeat(depth) + '> ' + '  '.repeat(row.depth) + (index === 0 && row.heading ? '#'.repeat(row.heading) + ' ' : '') + line)).join('\n');
    }
    const marker = capabilities.task?.status ? capabilities.task.status === 'done' ? '[x] ' : '[ ] ' : '';
    return plainText(block.text).split('\n').map((line, index) => '  '.repeat(depth) + (index === 0 ? marker : '') + line).join('\n');
  }).join('\n');
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function task(value: unknown): value is TaskState | null {
  if (value === null) return true;
  if (!record(value) || value.status !== null && !['todo', 'doing', 'waiting', 'done', 'cancelled'].includes(String(value.status))) return false;
  if (value.priority !== null && !['high', 'medium', 'low'].includes(String(value.priority))) return false;
  if (value.warning_days !== null && (!Number.isInteger(value.warning_days) || (value.warning_days as number) < 0)) return false;
  if (!['scheduled', 'scheduled_time', 'deadline', 'deadline_time', 'completed_on'].every(key => value[key] === null || typeof value[key] === 'string')) return false;
  return value.repeater === null || record(value.repeater) && Number.isInteger(value.repeater.every) && (value.repeater.every as number) > 0
    && ['day', 'week', 'month', 'year'].includes(String(value.repeater.unit))
    && ['fixed', 'catch_up', 'after_completion'].includes(String(value.repeater.mode));
}

/** Reject malformed private data before it can replace a selection. Plain text remains the fallback. */
export function parseBlockClipboard(text: string): BlockClipboard | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!record(value) || value.version !== 1 || typeof value.scope !== 'string' || typeof value.cut !== 'boolean' || !Array.isArray(value.blocks) || !value.blocks.length) return null;
  const ids = new Set<string>();
  let previousDepth = -1;
  for (const item of value.blocks) {
    if (!record(item) || !Number.isInteger(item.depth) || (item.depth as number) < 0 || (item.depth as number) > previousDepth + 1) return null;
    const block = item.block;
    const capabilities = item.capabilities;
    if (!record(block) || typeof block.id !== 'string' || !block.id || ids.has(block.id) || block.kind !== 'block'
      || typeof block.text !== 'string' || typeof block.parent_id !== 'string' || typeof block.page_id !== 'string'
      || ![null, 1, 2, 3].includes(block.heading as null | number) || typeof block.archived !== 'boolean'
      || !Number.isInteger(block.revision) || typeof block.created_at !== 'number' || typeof block.updated_at !== 'number'
      || !Array.isArray(item.manualTypes) || !item.manualTypes.every(title => typeof title === 'string')
      || !record(capabilities) || capabilities.block_id !== block.id || !task(capabilities.task)) return null;
    ids.add(block.id);
    previousDepth = item.depth as number;
  }
  return value as unknown as BlockClipboard;
}

/** getData returns an empty string for an absent type, which is not an empty-text paste. */
export function clipboardPlainText(data: Pick<DataTransfer, 'types' | 'getData'>): string | null {
  return Array.from(data.types).includes('text/plain') ? data.getData('text/plain') : null;
}

/** External links use the notebook's labeled-link spelling, never clipboard HTML. */
export function externalLink(url: string, caption: string): string {
  const target = url.replace(/\|/g, '%7C').replace(/\]/g, '%5D');
  const label = caption.replace(/[\r\n]+/g, ' ').replace(/\|/g, '｜').replace(/\]/g, '］');
  return label && label !== url ? `[[${target}|${label}]]` : target;
}

export function clipboardUrl(text: string): string | null {
  if (!/^https?:\/\/[^\s<>"']+$/i.test(text)) return null;
  try { return ['http:', 'https:'].includes(new URL(text).protocol) ? text : null; } catch { return null; }
}

/** Keep indentation but consume the same heading/task semantics as typed input. */
export function markdownPasteRows(text: string): PasteRow[] {
  let fenced = false;
  return text.replace(/\r\n?/g, '\n').split('\n').map(line => {
    const whitespace = /^[ \t]*/.exec(line)![0];
    const indent = [...whitespace].reduce((width, char) => width + (char === '\t' ? 2 : 1), 0);
    let body = line.slice(whitespace.length);
    let heading: PasteRow['heading'] = null;
    let task: PasteRow['task'] = null;
    if (/^(?:```|~~~)/.test(body)) fenced = !fenced;
    else if (!fenced) {
      body = body.replace(/^(?:[-+*]|\d+[.)])\s+/, '');
      const marker = /^\[([ xX]?)\]\s+/.exec(body);
      if (marker) { task = marker[1]?.toLowerCase() === 'x' ? 'done' : 'todo'; body = body.slice(marker[0].length); }
      const title = /^(#{1,6})\s+/.exec(body);
      if (title) { heading = Math.min(3, title[1]!.length) as 1 | 2 | 3; body = body.slice(title[0].length).replace(/\s+#+\s*$/, ''); }
      body = body.replace(/!?\[([^\]\r\n]*)\]\((https?:\/\/(?:[^\s()]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g,
        (match, caption: string, url: string) => clipboardUrl(url) ? externalLink(url, caption) : match);
    }
    return { text: body, indent, heading, task };
  });
}

/** Parse in an inert document and translate supported semantics; no HTML enters the notebook. */
export function htmlPasteRows(html: string): PasteRow[] {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const rows: PasteRow[] = [];
  const ignored: Record<string, true> = { SCRIPT: true, STYLE: true, NOSCRIPT: true, TEMPLATE: true, META: true, LINK: true, IFRAME: true, OBJECT: true };
  const blocks: Record<string, true> = { P: true, DIV: true, SECTION: true, ARTICLE: true, HEADER: true, FOOTER: true, BLOCKQUOTE: true, PRE: true, LI: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true, UL: true, OL: true, TABLE: true };
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ');
    if (!(node instanceof Element) || ignored[node.tagName]) return '';
    if (node.tagName === 'BR') return '\n';
    const text = [...node.childNodes].map(inline).join('');
    if (node.tagName === 'A') {
      const href = node.getAttribute('href')?.trim() ?? '';
      return clipboardUrl(href) ? externalLink(href, text.trim()) : text;
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src')?.trim() ?? '';
      const alt = node.getAttribute('alt') ?? '';
      return clipboardUrl(src) ? externalLink(src, alt) : alt;
    }
    return text;
  };
  const add = (text: string, depth: number, heading: PasteRow['heading'] = null) => {
    if (text.trim()) rows.push({ text: text.trim(), indent: depth * 2, heading, task: null });
  };
  const visit = (nodes: Iterable<Node>, depth: number) => {
    let text = '';
    const flush = () => { add(text, depth); text = ''; };
    for (const node of nodes) {
      if (!(node instanceof Element) || !blocks[node.tagName]) { text += inline(node); continue; }
      flush();
      if (node.tagName === 'UL' || node.tagName === 'OL') {
        for (const item of node.children) if (item.tagName === 'LI') visit(item.childNodes, depth + (node.parentElement?.tagName === 'LI' ? 1 : 0));
      } else if (node.tagName === 'LI') visit(node.childNodes, depth);
      else if (node.tagName === 'TABLE') {
        for (const row of node.querySelectorAll('tr')) {
          if (row.closest('table') === node) add([...row.children].filter(cell => ['TD', 'TH'].includes(cell.tagName)).map(cell => inline(cell).trim()).join(' | '), depth);
        }
      } else if (/^H[1-6]$/.test(node.tagName)) add(inline(node), depth, Math.min(3, Number(node.tagName[1])) as 1 | 2 | 3);
      else if (node.tagName === 'PRE') add(node.textContent ?? '', depth);
      else visit(node.childNodes, depth);
    }
    flush();
  };
  visit(body.childNodes, 0);
  return rows;
}

export function clipboardPasteRows(data: Pick<DataTransfer, 'types' | 'getData'>): PasteRow[] | null {
  if (Array.from(data.types).includes('text/html')) {
    const rows = htmlPasteRows(data.getData('text/html'));
    if (rows.length) return rows;
  }
  const text = Array.from(data.types).includes('text/markdown') ? data.getData('text/markdown') : clipboardPlainText(data);
  return text === null ? null : markdownPasteRows(text);
}
