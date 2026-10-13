import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { ulid } from 'ulid';
import type { Operation, SpreadReference, SpreadValue } from '../api/types';
import type { Edit, NotebookClient, PageDocument } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { createSettledChanges } from '../ui/loading';
import './spread.css';

interface SpreadPaneProps {
  noteIds?: string[];
  doc?: PageDocument;
  notebook: NotebookClient;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChange?(ids: string[]): void;
}

/** The saved form uses the same page document as its commentary, including its undo history. */
export function SpreadPane(props: SpreadPaneProps) {
  let pane: HTMLElement | undefined;
  const changes = createSettledChanges(props.notebook);
  const [result, { refetch }] = createResource(() => [props.doc?.pageId, props.noteIds?.join(','), changes()] as const,
    ([pageId]) => pageId ? props.notebook.api.savedSpread(pageId) : props.notebook.api.spread(props.noteIds ?? []));
  const ids = () => props.doc ? result.latest?.note_ids ?? [] : props.noteIds ?? [];
  const [picker, setPicker] = createSignal<HTMLElement>();
  const [query, setQuery] = createSignal('');
  const [save, setSave] = createSignal<HTMLElement>();
  const [title, setTitle] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [matches] = createResource(() => picker() ? query() : false, text => props.notebook.api.complete(text, 50));
  const choices = createMemo(() => (matches() ?? []).filter(row => row.kind === 'page' && row.text.toLocaleLowerCase() !== 'fields' && !ids().includes(row.id) && row.id !== props.doc?.pageId));
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const edit = async (value: Edit) => {
    const doc = props.doc;
    if (!doc || busy()) return;
    setBusy(true); setError('');
    try {
      const result = doc.edit(value);
      if (!result.ok) throw new Error(result.reason);
      await doc.flush();
      await refetch();
      pane?.focus({ preventScroll: true });
    } catch (reason) { fail(reason); }
    finally { setBusy(false); }
  };
  const references = (): SpreadReference[] => result.latest?.references ?? [];
  const add = (id: string) => {
    if (ids().length >= 5 || ids().includes(id) || busy()) return;
    setPicker(undefined);
    if (props.doc) void edit({ kind: 'insert', parentId: props.doc.pageId, after: references().at(-1)?.block_id ?? null, text: `[[${id}]]` });
    else props.onChange?.([...ids(), id]);
  };
  const remove = (index: number) => {
    if (props.doc) {
      const reference = references()[index];
      if (reference) void edit({ kind: 'delete', ids: [reference.block_id] });
    } else props.onChange?.(ids().filter((_, at) => at !== index));
  };
  const move = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= ids().length || busy()) return;
    if (props.doc) {
      const columns = references();
      const reference = columns[index];
      if (reference) void edit({ kind: 'moveTo', ids: [reference.block_id], parentId: props.doc.pageId,
        after: direction < 0 ? columns[destination - 1]?.block_id ?? null : columns[destination]!.block_id });
    } else {
      const next = [...ids()];
      [next[index], next[destination]] = [next[destination]!, next[index]!];
      props.onChange?.(next);
    }
  };
  const saveSpread = async (beside: boolean) => {
    const name = title().trim();
    if (!name || busy() || ids().length < 2) return;
    setBusy(true); setError('');
    try {
      if (await props.notebook.pageByTitle(name, false)) throw new Error('A page with this title already exists.');
      const id = ulid();
      const operations: Operation[] = [{ op: 'create_page', id, title: name }, { op: 'set_spread', id, base_revision: 1, spread: true }];
      let after: string | null = null;
      for (const noteId of ids()) {
        const blockId = ulid();
        operations.push({ op: 'insert', id: blockId, parent_id: id, after, text: `[[${noteId}]]`, heading: null });
        after = blockId;
      }
      await props.notebook.commit(operations, 'Save spread');
      setSave(undefined);
      props.onOpen({ kind: 'page', pageId: id }, beside);
    } catch (reason) { fail(reason); }
    finally { setBusy(false); }
  };
  const values = (items: SpreadValue[]) => <For each={items}>{value => <div class="spread-value">
    <Show when={value.target_id && !value.text.trim().startsWith('[[')} fallback={<BlockText text={value.text} notebook={props.notebook} onOpen={props.onOpen} />}>
      <Button class="spread-link" onClick={event => props.onOpen({ kind: 'page', pageId: value.target_id! }, event.shiftKey)}>{value.text}</Button>
    </Show>
    <Show when={value.shared}><span class="spread-mark" title="Shared" aria-label="Shared">=</span></Show>
    <Show when={value.between_columns}><span class="spread-mark" title="Links to a column" aria-label="Links to a column">↔</span></Show>
  </div>}</For>;
  return <section ref={pane} tabindex="-1" class={`spread-pane ${props.doc ? 'spread-saved' : 'spread-unsaved'}`} aria-label="Spread" onFocusIn={props.onActivate} onKeyDown={event => {
    if (props.doc && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault(); event.stopPropagation();
      event.shiftKey ? props.doc.redo() : props.doc.undo();
      void props.doc.flush().then(() => refetch()).catch(fail);
    }
  }}>
    <header class="spread-toolbar"><span class="spread-rubric">SPREAD</span><span class="section-rule" />
      <Button class="bordered" disabled={busy() || result.loading || ids().length >= 5 || !!result.error} onClick={event => { setQuery(''); setError(''); setPicker(event.currentTarget); }}>Add note…</Button>
      <Show when={!props.doc}><Button class="bordered" disabled={busy() || ids().length < 2 || !!result.error || result.loading} onClick={event => { setTitle(result.latest?.columns.map(column => column.title).join(' / ') ?? ''); setError(''); setSave(event.currentTarget); }}>Save spread</Button></Show>
    </header>
    <Show when={error() || result.error}><p class="error" role="alert">{error() || String(result.error)}</p></Show>
    <Show when={ids().length < 2}><p class="empty-state">Select two to five notes to compare them.</p></Show>
    <Show when={result.latest?.columns.length}>{count => <><div class="spread-scroll"><table class="spread-table" style={{ '--spread-count': count() }}>
      <thead><tr><th scope="col"><span class="visually-hidden">Notes</span></th><For each={result.latest!.columns}>{(column, index) => <th scope="col" data-note-id={column.id}>
        <div class="spread-kind">{column.kinds.map(kind => kind.name).join(' / ')}</div>
        <h2><Button class="spread-title" onClick={event => props.onOpen({ kind: 'page', pageId: column.id }, event.shiftKey)}>{column.title}</Button></h2>
        <div class="spread-gloss">{values(column.gloss)}</div>
        <div class="spread-column-controls">
          <Button icon="left" label="Move left" disabled={busy() || result.loading || index() === 0} onClick={() => move(index(), -1)} />
          <Button icon="right" label="Move right" disabled={busy() || result.loading || index() === ids().length - 1} onClick={() => move(index(), 1)} />
          <Button icon="close" label="Remove column" disabled={busy() || result.loading} onClick={() => remove(index())} />
        </div>
      </th>}</For></tr></thead>
      <tbody>
        <For each={result.latest!.fields}>{field => <tr data-field-id={field.id}><th scope="row">{field.name}</th><For each={field.cells}>{cell => <td>{values(cell)}</td>}</For></tr>}</For>
        <For each={['sources', 'links', 'opening'] as const}>{key => <tr data-spread-row={key}><th scope="row">{key === 'sources' ? 'Sources' : key === 'links' ? 'Links' : 'Opening'}</th><For each={result.latest!.columns}>{column => <td>{values(column[key])}</td>}</For></tr>}</For>
      </tbody>
    </table></div><p class="spread-legend">= Shared value · ↔ Links to another column</p></>}</Show>
    <Show when={picker()}>{anchor => <Picker anchor={anchor()} label="Add note" query={query()} onQuery={setQuery} placeholder="Find a note…" items={choices()} key={row => row.id} row={row => <span>{row.text}</span>} onPick={row => add(row.id)} onDismiss={() => setPicker(undefined)} busy={matches.loading} error={matches.error ? String(matches.error) : undefined} empty="No matching notes." />}</Show>
    <Show when={save()}>{anchor => <Popup anchor={anchor()} label="Save spread" onDismiss={() => { if (!busy()) setSave(undefined); }}>
      <form class="spread-save" onSubmit={event => { event.preventDefault(); void saveSpread(false); }}>
        <label>Title<input autofocus value={title()} disabled={busy()} onInput={event => setTitle(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void saveSpread(event.shiftKey); } }} /></label>
        <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
        <div class="popup-actions"><Button disabled={busy()} onClick={() => setSave(undefined)}>Cancel</Button><Button type="submit" class="bordered" disabled={busy() || !title().trim()}>Save spread</Button></div>
      </form>
    </Popup>}</Show>
  </section>;
}
