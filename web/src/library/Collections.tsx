import { For, Show, createResource, createSignal } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import type { Block } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { changeCollectionMembers, collectionPages, createCollection, sourceCollections } from '../document/collections';
import type { CollectionChange } from '../document/collections';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';

/** Like bulk task moves, keep just the last collection action's quiet Undo notice. */
export interface CollectionActions {
  busy: Accessor<boolean>;
  canUndo: Accessor<boolean>;
  record(change: CollectionChange | null, label: string): void;
  run(label: string, action: () => Promise<CollectionChange | null>): Promise<boolean>;
  undo(): Promise<void>;
  Notice(): JSX.Element;
}

export function createCollectionActions(): CollectionActions {
  const [changed, setChanged] = createSignal<{ label: string; change: CollectionChange } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const record = (change: CollectionChange | null, label: string) => { if (change) setChanged({ change, label }); };
  async function run(label: string, action: () => Promise<CollectionChange | null>): Promise<boolean> {
    if (busy()) return false;
    setBusy(true); setError('');
    try { record(await action(), label); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
    finally { setBusy(false); }
  }
  async function undo() {
    const value = changed();
    if (!value || busy()) return;
    setBusy(true); setError('');
    try { await value.change.undo(); setChanged(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const Notice = () => <>
    <Show when={changed()}>{value => <p class="library-message library-collection-notice" role="status">{value().label}<Button disabled={busy()} onClick={() => { void undo(); }}>Undo</Button></p>}</Show>
    <Show when={error()}><p class="library-error" role="alert">{error()}</p></Show>
  </>;
  return { busy, record, run, undo, canUndo: () => !!changed(), Notice };
}

export function CollectionNamePopup(props: { anchor: HTMLElement; name?: string; onDismiss(): void; onSave(name: string): Promise<void> }) {
  const [name, setName] = createSignal(props.name ?? '');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  async function save() {
    if (busy() || !name().trim()) return;
    setBusy(true); setError('');
    try { await props.onSave(name().trim()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <Popup anchor={props.anchor} label={props.name === undefined ? 'New collection' : 'Rename collection'} onDismiss={props.onDismiss}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label class="library-collection-name">Collection name<input class="input" aria-label="Collection name" value={name()} required disabled={busy()} onInput={event => setName(event.currentTarget.value)} /></label>
      <Show when={error()}><p class="library-error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button><Button class="bordered" type="submit" disabled={busy() || !name().trim()}>{props.name === undefined ? 'Create' : 'Save'}</Button></div>
    </form>
  </Popup>;
}

export function CollectionPicker(props: { anchor: HTMLElement; notebook: NotebookClient; sourceIds: readonly string[]; onChanged(change: CollectionChange | null, label: string): void; onDismiss(): void }) {
  const [collections] = createResource(() => props.notebook.changeSequence(), () => collectionPages(props.notebook.api));
  const [query, setQuery] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  async function add(collection: Block) {
    if (busy()) return;
    setBusy(true); setError('');
    try {
      const change = await changeCollectionMembers(props.notebook, collection.id, props.sourceIds, true);
      props.onChanged(change, `Added to ${collection.text}`); props.onDismiss();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <Show when={!creating()} fallback={<CollectionNamePopup anchor={props.anchor} onDismiss={() => setCreating(false)} onSave={async name => {
    const result = await createCollection(props.notebook, name, props.sourceIds);
    props.onChanged(result.change, `Created ${name}`); props.onDismiss();
  }} />}>
    <Picker anchor={props.anchor} label="Add to collection" placeholder="Find a collection" query={query()} onQuery={setQuery}
      items={[...(collections() ?? []).filter(collection => collection.text.toLocaleLowerCase().includes(query().toLocaleLowerCase())), null]}
      key={collection => collection?.id ?? 'new'} row={collection => <><Icon name={collection ? 'shelf' : 'plus'} /><span>{collection?.text ?? 'New collection…'}</span></>}
      disabledReason={() => busy() ? 'Saving…' : undefined} busy={collections.loading} error={error() || (collections.error ? String(collections.error) : '')}
      empty="No collections" onDismiss={props.onDismiss} onPick={collection => { if (collection) void add(collection); else setCreating(true); }} />
  </Show>;
}

/** Ordinary field values, edited immediately as one undoable action per add or remove. */
export function SourceCollections(props: { notebook: NotebookClient; sourceId: string; actions: CollectionActions }) {
  const [data] = createResource(() => [props.sourceId, props.notebook.changeSequence()] as const, async ([id]) => {
    const [pages, ids] = await Promise.all([collectionPages(props.notebook.api), sourceCollections(props.notebook.api, id)]);
    return pages.filter(page => ids.includes(page.id));
  });
  const [picker, setPicker] = createSignal<HTMLElement>();
  return <div class="library-details-row" role="group" aria-label="Collections"><span>Collections</span><div class="library-source-collections">
    <For each={data()}>{collection => <span class="library-collection-chip"><span>{collection.text}</span><Button icon="close" label={`Remove from ${collection.text}`} disabled={props.actions.busy()} onClick={() => { void props.actions.run(`Removed from ${collection.text}`, () => changeCollectionMembers(props.notebook, collection.id, [props.sourceId], false)); }} /></span>}</For>
    <Button icon="plus" disabled={props.actions.busy()} onClick={event => setPicker(event.currentTarget)}>Add to collection…</Button>
    <Show when={data.error}><p class="library-error" role="alert">{String(data.error)}</p></Show>
    <props.actions.Notice />
    <Show when={picker()}>{anchor => <CollectionPicker anchor={anchor()} notebook={props.notebook} sourceIds={[props.sourceId]} onChanged={props.actions.record} onDismiss={() => setPicker(undefined)} />}</Show>
  </div></div>;
}
