import { opensBeside } from '../shell/beside';
import { Show, createEffect, createMemo, createResource, createSignal, on } from 'solid-js';
import type { Query } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import type { Token } from '../document/text-tokens';
import { isViewReference, textTokens } from '../document/text-tokens';
import { ViewBody } from '../table/ViewBody';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { ViewPicker, viewReference } from './ViewPicker';
import './view-embed.css';

/** Only one whole reference becomes a live view; inline occurrences remain links. */
export function viewEmbedTarget(text: string): Token | undefined {
  const tokens = textTokens(text.trim());
  return tokens.length === 1 && isViewReference(tokens[0]!) ? tokens[0] : undefined;
}

export function ViewEmbed(props: { reference: Token; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void; onReplace(text: string): void; onRemove(): void }) {
  const [relink, setRelink] = createSignal<HTMLElement>();
  const [localQuery, setLocalQuery] = createSignal<Query>();
  const [views] = createResource(() => [props.reference.id, props.notebook.changeSequence()] as const, () => props.notebook.api.views());
  const view = createMemo(() => views()?.find(view => view.id === props.reference.id));
  createEffect(on(() => view()?.revision, () => setLocalQuery(undefined)));
  const query = createMemo(() => localQuery() ?? view()?.query);
  const [result] = createResource(() => {
    const saved = view();
    return saved && saved.query.layout !== 'desk' ? [saved.query, props.notebook.changeSequence()] as const : false;
  }, async ([query]) => props.notebook.api.query({ ...query, offset: 0, limit: 12 }));
  const open = (beside: boolean) => {
    const saved = view();
    if (saved) props.onOpen({ kind: 'table', typeId: saved.query.type, viewId: saved.id, query: saved.query }, beside);
  };
  return <section class="view-embed" data-view-embed={props.reference.id} aria-label={view()?.name || props.reference.alias || 'Saved view'}
    onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <Show when={view()} fallback={<div class="view-embed-missing">
      <Icon name="brokenLink" /><span>{views.loading ? 'Loading view…' : views.error ? 'Could not load view' : 'Missing view'}: {props.reference.alias || 'Saved view'}</span>
      <Button onClick={event => setRelink(event.currentTarget)}>Relink…</Button><Button onClick={props.onRemove}>Remove embed</Button>
      <Show when={views.error}><span class="error" role="alert">{String(views.error)}</span></Show>
    </div>}>
      <header class="view-embed-header"><Button class="view-embed-title" onClick={event => open(opensBeside(event))}>{view()?.name}</Button><Show when={view()?.query.purpose}><p>{view()?.query.purpose}</p></Show></header>
      <Show when={view()?.query.layout === 'desk'}><Button class="view-embed-all" onClick={event => open(opensBeside(event))}>Open desk</Button></Show>
      <Show when={view()?.query.layout !== 'desk'}>
      <Show when={result()}>{rows => <ViewBody query={query()!} result={rows()} notebook={props.notebook} onOpen={props.onOpen} onQueryChange={setLocalQuery} />}</Show>
      <Show when={result.loading && !result()}><p class="empty-state">Loading rows…</p></Show>
      <Show when={result.error}><p class="error" role="alert">{String(result.error)} <Button onClick={() => open(false)}>Open view</Button></p></Show>
      <Show when={result() && result()!.total > result()!.rows.length}><Button class="view-embed-all" onClick={event => open(opensBeside(event))}>Show all {result()!.total}</Button></Show>
      <Show when={result() && !result()!.rows.length}><p class="empty-state">No matching rows. <Button onClick={() => open(false)}>Open view to change its filters</Button></p></Show>
      </Show>
    </Show>
    <Show keyed when={relink()}>{anchor => <ViewPicker anchor={anchor} notebook={props.notebook} onDismiss={() => setRelink(undefined)} onPick={view => { props.onReplace(viewReference(view)); setRelink(undefined); }} />}</Show>
  </section>;
}
