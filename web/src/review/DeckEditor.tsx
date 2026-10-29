import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { ulid } from 'ulid';
import type { CardQuery, CardSelection, Deck, FieldDefinition, IndexKind } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { SourceQueryControls } from '../table/SourceQueryControls';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';
import { copyCardQuery, selectionLabels } from './query';
import './review.css';

export interface DeckEditorProps {
  anchor: PopupAnchor;
  notebook: NotebookClient;
  deck: Deck | null;
  query: CardQuery;
  onDismiss(): void;
  onSaved(id: string): void;
  /** Constrains the popup to its pane as well as the viewport. */
  bounds?: () => DOMRect | null;
}

/** Unsaved editor text, by deck (or `new`), kept while the editor is closed. */
const drafts = new Map<string, { revision: number | null; name: string; query: CardQuery }>();

export function DeckEditor(props: DeckEditorProps) {
  const id = props.deck?.id ?? ulid();
  const draftKey = props.deck?.id ?? 'new';
  const draft = drafts.get(draftKey);
  const restored = draft && draft.revision === (props.deck?.revision ?? null) ? draft : undefined;
  const [base, setBase] = createSignal(props.deck);
  const [name, setName] = createSignal(restored?.name ?? props.deck?.name ?? '');
  const [query, setQuery] = createSignal(copyCardQuery(restored?.query ?? props.deck?.query ?? props.query));
  const [fields, setFields] = createSignal<readonly FieldDefinition[]>([]);
  const [types, setTypes] = createSignal<readonly IndexKind[]>([]);
  const [current, setCurrent] = createSignal<Deck | null>(props.deck);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal('');
  const [error, setError] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  const [selectionAnchor, setSelectionAnchor] = createSignal<HTMLElement | null>(null);
  const [matching, setMatching] = createSignal<number | null>(null);
  // Typed filters and names must survive an outside click; only Cancel or Escape discards them.
  const initial = { name: props.deck?.name ?? '', query: JSON.stringify(copyCardQuery(props.deck?.query ?? props.query)) };
  const dirty = () => !saved() && (name() !== initial.name || JSON.stringify(copyCardQuery(query())) !== initial.query);
  const stale = () => !!base() && current()?.revision !== base()!.revision;
  const locked = () => pending() || saved() || ['saving', 'queued', 'offline'].includes(props.notebook.commandState());
  let disposed = false;
  let discarded = false;
  // Escape and an outside click close the editor; the draft waits for the next time it opens, until it is saved or cancelled.
  onCleanup(() => {
    disposed = true;
    if (dirty() && !discarded) drafts.set(draftKey, { revision: props.deck?.revision ?? null, name: name(), query: copyCardQuery(query()) });
    else drafts.delete(draftKey);
  });

  createEffect(() => {
    props.notebook.changeSequence(); retry();
    let cancelled = false;
    setLoading(true);
    void Promise.all([props.notebook.api.fields(), props.notebook.api.noteIndex(), props.deck ? props.notebook.api.deck(id) : Promise.resolve(null)])
      .then(([definitions, index, deck]) => {
        if (cancelled) return;
        setFields(definitions.fields); setTypes(index.kinds); setCurrent(deck); setLoadError(''); setLoading(false);
      }).catch(reason => {
        if (!cancelled) { setLoadError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
      });
    onCleanup(() => { cancelled = true; });
  });

  // The count previews the draft query; it never blocks saving.
  createEffect(() => {
    const draft = copyCardQuery(query());
    props.notebook.changeSequence();
    let cancelled = false;
    void props.notebook.api.cardQuery({ ...draft, limit: 1 })
      .then(result => { if (!cancelled) setMatching(result.total); })
      .catch(() => { if (!cancelled) setMatching(null); });
    onCleanup(() => { cancelled = true; });
  });

  async function save() {
    if (locked() || loading() || stale() || loadError() || !name().trim()) return;
    const operation = { op: 'save_deck' as const, id, base_revision: base()?.revision ?? null, name: name().trim(), query: copyCardQuery(query()) };
    setPending(true); setError('');
    try {
      await props.notebook.commit([operation], base() ? 'Edit deck' : 'New deck');
      if (disposed) return;
      setSaved(true);
      props.onSaved(id);
    } catch (reason) {
      if (!disposed) { setError(reason instanceof Error ? reason.message : String(reason)); setRetry(value => value + 1); }
    } finally {
      if (!disposed) setPending(false);
    }
  }

  function discard() {
    const deck = current();
    if (!deck || locked()) return;
    setBase(deck); setName(deck.name); setQuery(copyCardQuery(deck.query)); setError('');
  }

  return <Popup anchor={props.anchor} label={props.deck ? 'Edit deck' : 'New deck'} class="deck-editor" style={{ '--popup-room': `${props.bounds?.()?.width ?? window.innerWidth}px` }} bounds={props.bounds} dirty={dirty} onDismiss={() => { if (!pending()) props.onDismiss(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label class="deck-editor-name">Name<input class="input" value={name()} maxLength={120} disabled={locked()} onInput={event => setName(event.currentTarget.value)} /></label>
      <SourceQueryControls query={query().source} types={types()} fields={fields()} notebook={props.notebook} disabled={locked() || loading()} onChange={source => setQuery(value => ({ ...value, source }))} />
      <div class="deck-editor-queue"><span>Queue</span><Button class="bordered" disabled={locked()} aria-haspopup="menu" onClick={event => setSelectionAnchor(event.currentTarget)}>{selectionLabels[query().selection]}<Icon name="down" /></Button>
        <Show when={matching() !== null}><span class="deck-editor-match" role="status">{matching()} {matching() === 1 ? 'card matches' : 'cards match'}</span></Show>
      </div>
      <Show when={loadError()}><p class="error" role="alert">{loadError()} <Button disabled={pending()} onClick={() => setRetry(value => value + 1)}>Retry</Button></p></Show>
      <Show when={stale()}><p class="error" role="alert">This deck changed elsewhere. Your draft has not been saved. <Button disabled={locked()} onClick={discard}>Discard changes</Button></p></Show>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions">
        <Show when={pending() || loading()}><span class="deck-editor-saving" role="status">{pending() ? `Saving deck… ${props.notebook.commandMessage()}` : 'Loading source filters…'}</span></Show>
        <Button disabled={pending()} onClick={() => { discarded = true; props.onDismiss(); }}>Cancel</Button>
        <Show when={base() && !stale()}><Button disabled={locked()} onClick={discard}>Discard changes</Button></Show>
        <Button type="submit" class="bordered" disabled={locked() || loading() || stale() || !!loadError() || !name().trim()}>Save deck</Button>
      </div>
    </form>
    <Show keyed when={selectionAnchor()}>{anchor => <Menu anchor={anchor} label="Deck queue" onDismiss={() => setSelectionAnchor(null)} items={(Object.keys(selectionLabels) as CardSelection[]).map(selection => ({ label: selectionLabels[selection], checked: query().selection === selection, action: () => { if (!locked()) setQuery(value => ({ ...value, selection })); } }))} />}</Show>
  </Popup>;
}
