import { opensBeside } from '../shell/beside';
import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import type { Block, FieldDefinition } from '../api/types';
import type { OpenTarget } from '../shell/contract';
import { Icon } from '../ui/Icon';
import { TypePill } from './references';
import { isCapabilityTag } from './capabilities';
import { createCitationSources } from './source-reads';
import { Menu } from '../ui/Menu';
import { deletedHolderLabel, foldedHighlights, foldName, nameMenuItems, plainText, referenceLabel, resolveName, tagLabel } from './names';
import type { NameMatch } from '../api/types';
import { cardMarks, cardOperators } from '../review/card-text';
import type { CardMark } from '../review/card-text';

import { inlineTokens, isStableReference, isViewReference, quoteTarget, textTokens } from '../document/text-tokens';
import type { InlineToken } from '../document/text-tokens';

interface Props {
  text: string;
  notebook: NotebookClient;
  blockId?: string;
  onError?(message: string): void;
  field?: Pick<FieldDefinition, 'id' | 'name'>;
  deletedHolder?: { id: string; text: string } | null;
  onOpen?(target: OpenTarget, beside: boolean): void;
  onReferenceMenu?(id: string, anchor: HTMLElement): void;
  selection?: [number, number] | null;
  interactive?: boolean;
  highlight?: string;
  cards?: boolean;
  citationApparatus?: boolean;
}

interface DisplayToken extends InlineToken { label: string; visibleStart: number; target: Block | null | undefined; literal: boolean; matches?: NameMatch[] }
interface TokenGroup { mark?: CardMark; tokens: InlineToken[] }

/** A whole-row `((ID))` reads as a quote of its target wherever a block shows as text: backlinks, breadcrumbs, search. */
export function BlockText(props: Props) {
  const quoted = createMemo(() => quoteTarget(props.text));
  return <Show when={quoted()} keyed fallback={<TokenText {...props} />}>{id =>
    <span class="quote-label"><span class="quote-label-rubric">Quote</span><TokenText {...props} text={`[[${id}]]`} /></span>}</Show>;
}

function TokenText(props: Props) {
  const [menu, setMenu] = createSignal<{ token: DisplayToken; anchor: HTMLElement }>();
  const [error, setError] = createSignal('');
  const citationSources = createCitationSources(props.notebook, () => [props.text], () => !!props.citationApparatus);
  const names = createMemo(() => [...new Set(textTokens(props.text).flatMap(token => token.kind === 'reference' && !isStableReference(token) && !isViewReference(token) && token.id?.trim() ? [token.id.trim()] : []))]);
  const [matches] = createResource(() => names().length ? [names().join('\u0000'), props.notebook.changeSequence()] as const : false, async ([value]) =>
    new Map(await Promise.all(value.split('\u0000').map(async name => [foldName(name), await resolveName(props.notebook, name)] as const))));
  const [views] = createResource(() => textTokens(props.text).some(isViewReference) ? props.notebook.changeSequence() : false, () => props.notebook.api.views());
  // Card syntax reads the same everywhere text is shown; mapped literals keep caret positions exact around it.
  const marks = createMemo(() => cardMarks(props.text));
  const groups = createMemo(() => {
    const result: TokenGroup[] = [];
    const add = (start: number, end: number, mark?: CardMark) => {
      const tokens = inlineTokens(props.text.slice(start, end)).map(token => ({ ...token, start: token.start + start, end: token.end + start, ...(token.labelStart === undefined ? {} : { labelStart: token.labelStart + start }) }));
      result.push({ mark, tokens });
    };
    let offset = 0;
    for (const mark of marks()) {
      if (offset < mark.start) add(offset, mark.start);
      if (mark.kind === 'cloze') add(mark.answerStart, mark.answerEnd, mark);
      else result.push({ mark, tokens: [{ start: mark.start, end: mark.end, kind: 'text', value: cardOperators[mark.op].text }] });
      offset = mark.end;
    }
    if (offset < props.text.length) add(offset, props.text.length);
    return result;
  });
  const displayed = createMemo(() => {
    let visibleStart = 0;
    return groups().map(group => ({ ...group, tokens: group.tokens.map(token => {
      const resolved = token.kind === 'reference' && !isStableReference(token) && !isViewReference(token) && !matches.error ? matches()?.get(foldName(token.id!)) : undefined;
      const ambiguous = !!resolved && resolved.length > 1;
      const literal = group.mark?.kind !== 'operator' && (token.kind === 'text' || token.kind === 'reference' && !isStableReference(token) && !isViewReference(token) && !ambiguous);
      const target = isStableReference(token) || token.kind === 'tag' && token.id ? props.notebook.lookup(token.id!)() : undefined;
      const field = props.field?.id === token.id ? props.field : undefined;
      const baseLabel = isViewReference(token) ? views()?.find(view => view.id === token.id)?.name || token.alias || 'Saved view' : ambiguous ? token.alias || token.id! : token.kind === 'url' ? token.alias ?? token.value : group.mark?.kind === 'operator' || literal ? token.value : token.kind === 'tag' ? `#${tagLabel(token, id => props.notebook.lookup(id))}` : field ? token.alias || field.name : referenceLabel(token, target, id => props.notebook.lookup(id), undefined, props.deletedHolder && props.deletedHolder.id === token.id ? deletedHolderLabel(props.deletedHolder) : undefined);
      const source = props.citationApparatus ? citationSources()?.get(token.id!) : undefined;
      const label = (source?.siglum ?? baseLabel) + (!literal && token.locator ? `${source ? ' · ' : '\u2009'}${token.locator}` : '');
      const result: DisplayToken = { ...token, label, target, literal, visibleStart, matches: ambiguous ? resolved : undefined };
      visibleStart += label.length;
      return result;
    }) }));
  });
  const highlights = createMemo(() => {
    const query = props.highlight;
    if (!query) return [];
    const value = displayed().flatMap(group => group.tokens.map(token => token.label)).join('');
    return foldedHighlights(value, query);
  });
  function text(token: DisplayToken) {
    const selection = props.selection;
    const hits = highlights().filter(([start, end]) => start < token.visibleStart + token.label.length && end > token.visibleStart);
    const locatorStart = !token.literal && token.locator ? token.label.length - token.locator.length - (props.citationApparatus && citationSources()?.has(token.id!) ? 3 : 1) : token.label.length;
    if (!selection && !hits.length) return <>{token.label.slice(0, locatorStart)}<Show when={locatorStart < token.label.length}><span class="reference-locator">{token.label.slice(locatorStart)}</span></Show></>;
    const selected = selection && (token.literal
      ? [Math.max(0, selection[0] - token.start), Math.min(token.label.length, selection[1] - token.start)] as const
      : selection[0] < token.end && selection[1] > token.start ? [0, token.label.length] as const : null);
    const boundaries = new Set([0, locatorStart, token.label.length]);
    for (const [start, end] of hits) { boundaries.add(Math.max(0, start - token.visibleStart)); boundaries.add(Math.min(token.label.length, end - token.visibleStart)); }
    if (selected && selected[0] < selected[1]) { boundaries.add(selected[0]); boundaries.add(selected[1]); }
    const points = [...boundaries].sort((a, b) => a - b);
    return <For each={points.slice(0, -1)}>{(start, index) => {
      const end = points[index() + 1]!;
      const value = token.label.slice(start, end);
      const marked = hits.some(([a, b]) => token.visibleStart + start >= a && token.visibleStart + end <= b);
      const chosen = selected && start >= selected[0] && end <= selected[1];
      const rendered = chosen ? <mark>{marked ? <mark class="outline-highlight">{value}</mark> : value}</mark> : marked ? <mark class="outline-highlight">{value}</mark> : value;
      return start >= locatorStart ? <span class="reference-locator">{rendered}</span> : rendered;
    }}</For>;
  }
  function activateReference(token: DisplayToken, anchor: HTMLElement, event: MouseEvent | KeyboardEvent) {
    if (isViewReference(token)) {
      const view = views()?.find(view => view.id === token.id);
      if (view) props.onOpen?.({ kind: 'table', typeId: view.query.type, viewId: view.id, query: view.query }, opensBeside(event));
      return;
    }
    if (token.matches && props.blockId) { setMenu({ token, anchor }); return; }
    const block = token.target;
    if (block) props.onOpen?.({ kind: 'page', pageId: block.page_id, blockId: block.kind === 'block' ? block.id : undefined }, opensBeside(event));
  }
  function formatted(token: DisplayToken, content: JSX.Element): JSX.Element {
    for (const format of token.formats ?? []) {
      const child = content;
      content = format === 'bold' ? <strong>{child}</strong> : format === 'italic' ? <em>{child}</em> : <code class="inline-code">{child}</code>;
    }
    return content;
  }
  function renderTokens(tokens: DisplayToken[]) {
    return <For each={tokens}>{token => formatted(token, <>
      <Show when={token.literal}>
        <span data-source-start={token.start} data-source-end={token.end} data-source-literal>{text(token)}</span>
      </Show>
      <Show when={!token.literal && token.kind === 'reference'}>
        <Show when={props.interactive !== false || token.matches && props.blockId} fallback={<span class="outline-reference" classList={{ 'outline-reference-ambiguous': !!token.matches, 'outline-citation': !!citationSources()?.has(token.id!) && !!(token.alias || token.locator) }} data-source-start={token.start} data-source-end={token.end} data-reference={isStableReference(token) ? token.id : undefined}>
          <Show when={props.field?.id === token.id}><Icon name="field" /></Show><Show when={token.target === null}><Icon name="brokenLink" /></Show>{text(token)}<Show when={token.matches}><sup>?</sup></Show>
        </span>}>
          <span class="outline-reference" classList={{ 'outline-reference-ambiguous': !!token.matches, 'outline-citation': !!citationSources()?.has(token.id!) && !!(token.alias || token.locator) }} role="button" tabIndex={0} data-source-start={token.start} data-source-end={token.end} data-reference={isStableReference(token) ? token.id : undefined}
            data-citation={!!citationSources()?.has(token.id!) && !!(token.alias || token.locator) ? '' : undefined} data-locator={token.locator}
            aria-label={token.matches ? `“${token.id}” names ${token.matches.length} pages` : undefined} aria-haspopup={token.matches ? 'menu' : undefined}
            onMouseDown={event => event.stopPropagation()}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) activateReference(token, event.currentTarget, event); } }}
            onClick={event => { event.stopPropagation(); activateReference(token, event.currentTarget, event); }}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (isViewReference(token)) return; if (token.matches && props.blockId) setMenu({ token, anchor: event.currentTarget }); else props.onReferenceMenu?.(token.id!, event.currentTarget); }}>
            <Show when={props.field?.id === token.id}><Icon name="field" /></Show><Show when={token.target === null}><Icon name="brokenLink" /></Show>{text(token)}<Show when={token.matches}><sup>?</sup></Show>
          </span>
        </Show>
      </Show>
      <Show when={token.kind === 'url'}>
        <Show when={props.interactive !== false} fallback={<span class="reference-url" data-source-start={token.labelStart ?? token.start} data-source-end={token.labelStart === undefined ? token.end : token.labelStart + token.label.length} data-source-literal>{text(token)}</span>}>
          <a class="reference-url" href={token.value} target="_blank" rel="noopener noreferrer" data-source-start={token.start} data-source-end={token.end}
            onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}><span data-source-start={token.labelStart ?? token.start} data-source-end={(token.labelStart ?? token.start) + token.label.length} data-source-literal>{text(token)}</span></a>
        </Show>
      </Show>
      <Show when={token.kind === 'tag' && !isCapabilityTag(token.target?.text ?? (token.id ? '' : token.value))}>
        <TypePill id={token.id} title={token.alias || token.value} notebook={props.notebook} onOpen={props.onOpen} interactive={props.interactive} start={token.start} end={token.end}>{text(token)}</TypePill>
      </Show>
    </>)}</For>;
  }
  return <><For each={displayed()}>{group => {
    const mark = group.mark;
    if (mark?.kind === 'operator') return <span class="card-operator" aria-label={cardOperators[mark.op].label} data-source-start={mark.start} data-source-end={mark.end}>{text(group.tokens[0]!)}</span>;
    if (mark?.kind === 'cloze') return <span class="card-cloze" title={`Cloze ${mark.id}${mark.hintStart === null ? '' : ` · ${props.text.slice(mark.hintStart, mark.hintEnd!)}`}`}>{renderTokens(group.tokens)}</span>;
    return renderTokens(group.tokens);
  }}</For><Show when={menu()}>{state => <Menu anchor={state().anchor} label="Choose a page" header={<div class="menu-section">“{state().token.id}” names {state().token.matches!.length} pages</div>}
    items={nameMenuItems(props.notebook, props.blockId!, state().token, state().token.matches!, message => props.onError ? props.onError(message) : setError(message))} onDismiss={() => setMenu(undefined)} />}</Show>
    <Show when={error()}><span class="error" role="alert">{error()}</span></Show></>;
}

/** The source location of a block. A descriptor card already names its parent, so it can omit it. */
export function BlockBreadcrumb(props: { block: Block; notebook: NotebookClient; omitParent?: boolean }) {
  const path = createMemo(() => {
    if (props.block.kind !== 'block') return plainText(props.block.text, id => props.notebook.lookup(id)) || (props.block.kind === 'journal' ? 'Journal' : 'Untitled page');
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
    const segments = [page ? plainText(page.text, id => props.notebook.lookup(id)) || 'Untitled page' : 'Loading page…', ...ancestors];
    // Keep the page title when it is the parent: the source button needs a label.
    if (props.omitParent && segments.length > 1) segments.pop();
    return segments.join(' › ');
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
