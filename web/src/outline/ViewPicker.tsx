import { Show, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import type { View } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { Icon } from '../ui/Icon';
import { completeNames } from './names';
import { documentReady } from './source-fields';
import type { OutlineContext } from './context';

export function viewReference(view: Pick<View, 'id' | 'name'>): string {
  return `[[view:${view.id}|${view.name.replaceAll(']', '').replaceAll('|', ' ')}]]`;
}

export function ViewPicker(props: { anchor: PopupAnchor; notebook: NotebookClient; onDismiss(): void; onPick(view: View): void; error?: string }) {
  const [query, setQuery] = createSignal('');
  const [views] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.views());
  const choices = createMemo(() => (views() ?? []).filter(view => view.name.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase())));
  return <Picker anchor={props.anchor} label="Embed view" query={query()} onQuery={setQuery} placeholder="Find a saved view" items={choices()} key={view => view.id}
    onDismiss={props.onDismiss} onPick={props.onPick} busy={views.loading} error={props.error || (views.error ? String(views.error) : undefined)}
    empty={query().trim() ? 'No matching views. Try another name.' : 'No saved views. Save a view from a table first.'}
    row={view => <><Icon name="table" /><span class="picker-text">{view.name}</span><Show when={view.query.purpose}><span class="picker-meta">{view.query.purpose}</span></Show></>} />;
}

export function EmbedOnPagePicker(props: { anchor: PopupAnchor; view: View; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void; onDismiss(): void }) {
  const [query, setQuery] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [names] = createResource(() => [query(), props.notebook.roots()] as const, ([text, roots]) => completeNames(props.notebook, text, roots));
  const insert = async (pageId: string) => {
    if (busy()) return;
    setBusy(true); setError('');
    const doc = props.notebook.open(pageId);
    try {
      await documentReady(doc);
      const children = doc.outline.children(pageId);
      const written = doc.edit({ kind: 'insert', parentId: pageId, after: children.at(-1) ?? null, text: viewReference(props.view) });
      if (!written.ok) throw new Error(written.reason);
      await doc.flush();
      props.onDismiss();
      props.onOpen({ kind: 'page', pageId, blockId: written.created[0] }, false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { doc.release(); setBusy(false); }
  };
  return <Picker anchor={props.anchor} label="Embed on atom" query={query()} onQuery={setQuery} placeholder="Find an atom" items={names()?.rows ?? []} key={match => match.page.id}
    onDismiss={() => { if (!busy()) props.onDismiss(); }} onPick={match => { void insert(match.page.id); }} busy={names.loading || busy()} error={error() || (names.error ? String(names.error) : undefined)}
    empty="No matching atoms. Try another name." row={match => <><Icon name="note" /><span class="picker-text">{match.page.text}</span><Show when={match.alias}><span class="reference-via">via {match.alias}</span></Show></>} />;
}

export function createViewEmbedActions(context: Pick<OutlineContext, 'props' | 'doc' | 'rowAnchor' | 'heading' | 'selected' | 'apply' | 'rowFocus' | 'editing' | 'editor' | 'restoreFocus'>) {
  const [state, setState] = createSignal<{ id: string | null; anchor: PopupAnchor }>();
  function openViewEmbed(id = context.selected()) {
    setState({ id, anchor: id ? context.rowAnchor(id) ?? context.heading : context.heading });
  }
  const unregister = context.props.commands.register([{
    id: `outline.${context.props.pane}.embed-view`, title: 'Embed view', section: 'Page',
    disabledReason: () => !context.props.active ? 'This pane is not active.' : context.doc.status() !== 'ready' ? 'Atom is unavailable.' : undefined,
    run: () => openViewEmbed(),
  }]);
  onCleanup(unregister);
  function ViewEmbedPopups() {
    return <Show keyed when={state()}>{current => <ViewPicker anchor={current.anchor} notebook={context.props.notebook} onDismiss={() => { setState(undefined); context.restoreFocus(); }} onPick={view => {
      const block = current.id ? context.doc.block(current.id) : undefined;
      const text = viewReference(view);
      const written = block && !block.text.trim()
        ? context.apply({ kind: 'text', id: block.id, text }, false)
        : context.apply({ kind: 'insert', parentId: block ? context.doc.outline.parentOf(block.id) : context.props.pageId, after: block?.id ?? context.doc.outline.children(context.props.pageId).at(-1) ?? null, text }, false);
      setState(undefined);
      if (written?.ok) context.rowFocus(written.created[0] ?? block!.id);
    }} />}</Show>;
  }
  return { openViewEmbed, ViewEmbedPopups };
}
