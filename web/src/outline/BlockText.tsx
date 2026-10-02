import { For, Show, createMemo } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import type { Block, FieldDefinition } from '../api/types';
import type { OpenTarget } from '../shell/contract';
import { Icon } from '../ui/Icon';
import { TypePill } from './references';

export interface Token { start: number; end: number; kind: 'text' | 'reference' | 'tag'; value: string; id?: string; alias?: string }
export function textTokens(text: string): Token[] {
  const result: Token[] = [];
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|(?<![\p{L}\p{N}_])#(?:\[\[([^\]]+)\]\]|([\p{L}\p{N}_/-]+))/gu;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > offset) result.push({ start: offset, end: start, kind: 'text', value: text.slice(offset, start) });
    const end = start + match[0].length;
    result.push(match[1] !== undefined
      ? { start, end, kind: 'reference', value: match[0], id: match[1], alias: match[2] }
      : { start, end, kind: 'tag', value: match[3] ?? match[4] ?? '' });
    offset = end;
  }
  if (offset < text.length) result.push({ start: offset, end: text.length, kind: 'text', value: text.slice(offset) });
  return result;
}

interface Props {
  text: string;
  notebook: NotebookClient;
  field?: Pick<FieldDefinition, 'id' | 'name'>;
  onOpen?(target: OpenTarget, beside: boolean): void;
  onReferenceMenu?(id: string, anchor: HTMLElement): void;
  selection?: [number, number] | null;
  interactive?: boolean;
  highlight?: string;
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
interface DisplayToken extends Token { label: string; visibleStart: number; target: Block | null | undefined; literal: boolean }

export function BlockText(props: Props) {
  const tokens = createMemo(() => textTokens(props.text));
  const displayed = createMemo(() => {
    let visibleStart = 0;
    return tokens().map(token => {
      const literal = token.kind === 'text' || token.kind === 'reference' && !isStableReference(token);
      const target = isStableReference(token) ? props.notebook.lookup(token.id!)() : undefined;
      const field = props.field?.id === token.id ? props.field : undefined;
      const label = literal ? token.value : token.kind === 'tag' ? `#${token.value}` : field ? token.alias || field.name : referenceLabel(token, target);
      const result: DisplayToken = { ...token, label, target, literal, visibleStart };
      visibleStart += label.length;
      return result;
    });
  });
  const highlights = createMemo(() => {
    const query = props.highlight;
    if (!query) return [];
    const value = displayed().map(token => token.label).join('');
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
  return <For each={tokens()}>{(token, index) => {
    const display = () => displayed()[index()]!;
    return <>
      <Show when={display().literal}>{text(display())}</Show>
      <Show when={!display().literal && token.kind === 'reference'}>
        <Show when={props.interactive !== false} fallback={<span class="outline-reference" data-source-start={token.start} data-source-end={token.end}>
          <Show when={props.field?.id === token.id}><Icon name="field" /></Show><Show when={display().target === null}><Icon name="brokenLink" /></Show>{text(display())}
        </span>}>
          <button class="outline-reference" type="button" data-source-start={token.start} data-source-end={token.end}
            onClick={event => { event.stopPropagation(); const block = display().target; if (block) props.onOpen?.({ kind: 'page', pageId: block.page_id, blockId: block.kind === 'block' ? block.id : undefined }, true); }}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); props.onReferenceMenu?.(token.id!, event.currentTarget); }}
            title={display().target ? 'Open reference beside · right-click for more actions' : display().target === null ? `Unresolved reference: ${token.id}` : 'Loading reference…'}>
            <Show when={props.field?.id === token.id}><Icon name="field" /></Show><Show when={display().target === null}><Icon name="brokenLink" /></Show>{text(display())}
          </button>
        </Show>
      </Show>
      <Show when={token.kind === 'tag'}>
        <Show when={props.interactive !== false} fallback={<span class="outline-tag" data-source-start={token.start} data-source-end={token.end}>{text(display())}</span>}>
          <TypePill title={token.value} notebook={props.notebook} onOpen={props.onOpen} start={token.start} end={token.end}>{text(display())}</TypePill>
        </Show>
      </Show>
    </>;
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
      ancestors.unshift(block.text || 'Empty block');
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
