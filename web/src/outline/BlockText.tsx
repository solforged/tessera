import { For, Show, createMemo } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import type { Block, FieldDefinition } from '../api/types';
import type { OpenTarget } from '../shell/contract';
import { Icon } from '../ui/Icon';
import { TypePill } from './references';
import { cardMarks } from '../review/card-text';
import type { CardMark } from '../review/card-text';

import { textTokens } from '../document/text-tokens';
import type { Token } from '../document/text-tokens';

interface Props {
  text: string;
  notebook: NotebookClient;
  field?: Pick<FieldDefinition, 'id' | 'name'>;
  onOpen?(target: OpenTarget, beside: boolean): void;
  onReferenceMenu?(id: string, anchor: HTMLElement): void;
  selection?: [number, number] | null;
  interactive?: boolean;
  highlight?: string;
  cards?: boolean;
}

export function isStableReference(token: Token): boolean {
  return token.kind === 'reference' && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(token.id ?? '');
}
export function referenceLabel(token: Token, target: Block | null | undefined): string {
  if (!isStableReference(token)) return token.value;
  if (target === undefined) return token.alias || 'Loading reference…';
  if (target === null) return `Unresolved ${token.id}`;
  return token.alias || target.text || 'Empty block';
}
/** One line of display text: references read as their targets and tags keep their `#`, for breadcrumbs and labels. */
export function plainText(text: string, lookup: NotebookClient['lookup']): string {
  return textTokens(text).map(token => isStableReference(token) ? referenceLabel(token, lookup(token.id!)()) : token.kind === 'tag' ? `#${token.value}` : token.value).join('');
}
interface DisplayToken extends Token { label: string; visibleStart: number; target: Block | null | undefined; literal: boolean }
interface TokenGroup { mark?: CardMark; tokens: Token[] }
const operators = { '>>': { label: 'then', text: '→' }, '<<': { label: 'from', text: '←' }, '<>': { label: 'both ways', text: '↔' }, '>>>': { label: 'child answer', text: '↓' }, '>>1.': { label: 'list answer', text: '↓1.' } };

export function BlockText(props: Props) {
  const groups = createMemo(() => {
    const marks = props.cards ? cardMarks(props.text) : [];
    const result: TokenGroup[] = [];
    const add = (start: number, end: number, mark?: CardMark) => {
      const tokens = textTokens(props.text.slice(start, end)).map(token => ({ ...token, start: token.start + start, end: token.end + start }));
      result.push({ mark, tokens });
    };
    let offset = 0;
    for (const mark of marks) {
      if (offset < mark.start) add(offset, mark.start);
      if (mark.kind === 'cloze') add(mark.answerStart, mark.answerEnd, mark);
      else result.push({ mark, tokens: [{ start: mark.start, end: mark.end, kind: 'text', value: operators[mark.op].text }] });
      offset = mark.end;
    }
    if (offset < props.text.length) add(offset, props.text.length);
    return result;
  });
  const displayed = createMemo(() => {
    let visibleStart = 0;
    return groups().map(group => ({ ...group, tokens: group.tokens.map(token => {
      const literal = group.mark?.kind !== 'operator' && (token.kind === 'text' || token.kind === 'reference' && !isStableReference(token));
      const target = isStableReference(token) ? props.notebook.lookup(token.id!)() : undefined;
      const field = props.field?.id === token.id ? props.field : undefined;
      const label = group.mark?.kind === 'operator' || literal || token.kind === 'url' ? token.value : token.kind === 'tag' ? `#${token.value}` : field ? token.alias || field.name : referenceLabel(token, target);
      const result: DisplayToken = { ...token, label, target, literal, visibleStart };
      visibleStart += label.length;
      return result;
    }) }));
  });
  const highlights = createMemo(() => {
    const query = props.highlight;
    if (!query) return [];
    const value = displayed().flatMap(group => group.tokens.map(token => token.label)).join('');
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return [...value.matchAll(pattern)].map(match => [match.index, match.index + match[0].length] as const);
  });
  function text(token: DisplayToken) {
    const selection = props.selection;
    const hits = highlights().filter(([start, end]) => start < token.visibleStart + token.label.length && end > token.visibleStart);
    if (!selection && !hits.length) return token.label;
    const selected = selection && (token.literal
      ? [Math.max(0, selection[0] - token.start), Math.min(token.label.length, selection[1] - token.start)] as const
      : selection[0] < token.end && selection[1] > token.start ? [0, token.label.length] as const : null);
    const boundaries = new Set([0, token.label.length]);
    for (const [start, end] of hits) { boundaries.add(Math.max(0, start - token.visibleStart)); boundaries.add(Math.min(token.label.length, end - token.visibleStart)); }
    if (selected && selected[0] < selected[1]) { boundaries.add(selected[0]); boundaries.add(selected[1]); }
    const points = [...boundaries].sort((a, b) => a - b);
    return <For each={points.slice(0, -1)}>{(start, index) => {
      const end = points[index() + 1]!;
      const value = token.label.slice(start, end);
      const marked = hits.some(([a, b]) => token.visibleStart + start >= a && token.visibleStart + end <= b);
      const chosen = selected && start >= selected[0] && end <= selected[1];
      return chosen ? <mark>{marked ? <mark class="outline-highlight">{value}</mark> : value}</mark> : marked ? <mark class="outline-highlight">{value}</mark> : value;
    }}</For>;
  }
  function renderTokens(tokens: DisplayToken[]) {
    return <For each={tokens}>{token => <>
      <Show when={token.literal}>
        <Show when={props.cards} fallback={text(token)}><span data-source-start={token.start} data-source-end={token.end} data-source-literal>{text(token)}</span></Show>
      </Show>
      <Show when={!token.literal && token.kind === 'reference'}>
        <Show when={props.interactive !== false} fallback={<span class="outline-reference" data-source-start={token.start} data-source-end={token.end}>
          <Show when={props.field?.id === token.id}><Icon name="field" /></Show><Show when={token.target === null}><Icon name="brokenLink" /></Show>{text(token)}
        </span>}>
          <button class="outline-reference" type="button" data-source-start={token.start} data-source-end={token.end} data-reference={isStableReference(token) ? token.id : undefined}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => { event.stopPropagation(); const block = token.target; if (block) props.onOpen?.({ kind: 'page', pageId: block.page_id, blockId: block.kind === 'block' ? block.id : undefined }, true); }}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); props.onReferenceMenu?.(token.id!, event.currentTarget); }}>
            <Show when={props.field?.id === token.id}><Icon name="field" /></Show><Show when={token.target === null}><Icon name="brokenLink" /></Show>{text(token)}
          </button>
        </Show>
      </Show>
      <Show when={token.kind === 'url'}>
        <Show when={props.interactive !== false} fallback={<span class="reference-url" data-source-start={token.start} data-source-end={token.end}>{text(token)}</span>}>
          <a class="reference-url" href={token.value} target="_blank" rel="noopener noreferrer" data-source-start={token.start} data-source-end={token.end}
            onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>{text(token)}</a>
        </Show>
      </Show>
      <Show when={token.kind === 'tag'}>
        <Show when={props.interactive !== false} fallback={<span class="outline-tag" data-source-start={token.start} data-source-end={token.end}>{text(token)}</span>}>
          <TypePill title={token.value} notebook={props.notebook} onOpen={props.onOpen} start={token.start} end={token.end}>{text(token)}</TypePill>
        </Show>
      </Show>
    </>}</For>;
  }
  return <For each={displayed()}>{group => {
    const mark = group.mark;
    if (mark?.kind === 'operator') return <span class="card-operator" aria-label={operators[mark.op].label} data-source-start={mark.start} data-source-end={mark.end}>{text(group.tokens[0]!)}</span>;
    if (mark?.kind === 'cloze') return <span class="card-cloze" title={`Cloze ${mark.id}${mark.hintStart === null ? '' : ` · ${props.text.slice(mark.hintStart, mark.hintEnd!)}`}`}>{renderTokens(group.tokens)}</span>;
    return renderTokens(group.tokens);
  }}</For>;
}

export function BlockBreadcrumb(props: { block: Block; notebook: NotebookClient }) {
  const path = createMemo(() => {
    if (props.block.kind !== 'block') return props.block.kind === 'journal' ? 'Journal' : 'Page';
    const ancestors: string[] = [];
    const seen = new Set<string>();
    let parent = props.block.parent_id;
    while (parent && parent !== props.block.page_id && !seen.has(parent)) {
      seen.add(parent);
      const block = props.notebook.lookup(parent)();
      if (!block) break;
      ancestors.unshift(plainText(block.text, id => props.notebook.lookup(id)) || 'Empty block');
      parent = block.parent_id;
    }
    const page = props.notebook.lookup(props.block.page_id)();
    return [page?.text ?? 'Loading page…', ...ancestors].join(' › ');
  });
  return <>{path()}</>;
}

/** Rendered labels map to whole raw tokens, never to invisible reference delimiters. */
export function offsetAtPoint(element: HTMLElement, text: string, x: number, y: number): number {
  const dom = element.ownerDocument as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const range = dom.caretRangeFromPoint?.(x, y);
  if (!range || !element.contains(range.startContainer)) return text.length;
  const token = range.startContainer.parentElement?.closest<HTMLElement>('[data-source-end]');
  if (token?.hasAttribute('data-source-literal') && element.contains(token)) {
    const within = dom.createRange();
    within.selectNodeContents(token);
    within.setEnd(range.startContainer, range.startOffset);
    return Math.min(Number(token.dataset.sourceEnd), Number(token.dataset.sourceStart) + within.toString().length);
  }
  if (token && element.contains(token)) return Number(token.dataset.sourceEnd);
  const before = dom.createRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  // Raw source positions are available on every decorated token.
  let length = before.toString().length;
  for (const decorated of element.querySelectorAll<HTMLElement>('[data-source-end]')) {
    if (before.intersectsNode(decorated)) length += Number(decorated.dataset.sourceEnd) - Number(decorated.dataset.sourceStart) - (decorated.textContent?.length ?? 0);
  }
  return Math.max(0, Math.min(text.length, length));
}
