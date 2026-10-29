import { For, Index, Show, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import type { Block } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { opensBeside } from '../shell/beside';
import { documentReady } from '../outline/source-fields';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { MetadataField } from './MetadataField';
import { derivedSourceSiglum, similarPages } from './details';
import type { SourceCreator, SourceFieldChange } from './details';
import { titleKey } from '../document/title-key';

const roles: readonly { role: SourceCreator['role']; label: string }[] = [{ role: 'author', label: 'Author' }, { role: 'editor', label: 'Editor' }, { role: 'translator', label: 'Translator' }];

export function MetadataCreators(props: {
  notebook: NotebookClient;
  docs: readonly PageDocument[];
  value: SourceCreator[];
  disabled: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onSave(value: SourceCreator[]): Promise<void>;
  onChange(label: string, count: number, operation: () => Promise<SourceFieldChange | undefined>): Promise<void>;
  onPermanentChange(): void;
  onError(message: string): void;
}) {
  const [menu, setMenu] = createSignal<{ anchor: HTMLElement; label: string; items: MenuItem[] }>();
  const [person, setPerson] = createSignal<SourceCreator>();
  const [renaming, setRenaming] = createSignal<string>();
  const [merging, setMerging] = createSignal<{ person: SourceCreator & { id: string }; anchor: HTMLElement }>();
  const [mergeTarget, setMergeTarget] = createSignal<Block>();
  const [query, setQuery] = createSignal('');
  const [error, setError] = createSignal('');
  let addButton: HTMLButtonElement | undefined;
  /** The row that held focus is gone and the button that opened it is new; WebKit never focuses a clicked button, so focus goes there explicitly. */
  const focusAddButton = () => queueMicrotask(() => { if (!disposed && addButton?.isConnected) addButton.focus({ preventScroll: true }); });
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal('');
  const [role, setRole] = createSignal<SourceCreator['role']>('author');
  const [busy, setBusy] = createSignal(false);
  let addRow: HTMLDivElement | undefined;
  let addInput: HTMLInputElement | undefined;
  let creatorRows!: HTMLDivElement;
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const similar = createMemo(() => similarPages(name(), props.notebook.roots()));
  const [counts] = createResource(() => {
    const id = person()?.id;
    return id && (menu() || renaming() || merging()) ? [id, props.notebook.changeSequence()] as const : undefined;
  }, async ([id]) => {
    const [backlinks, works] = await Promise.all([
      props.notebook.api.backlinks(id, 1000),
      props.notebook.api.library({ people: [id], limit: Number.MAX_SAFE_INTEGER }),
    ]);
    const books = new Set(works.rows.map(row => row.page.id));
    const notes = new Set(backlinks.filter(link => !books.has(link.page.id) || link.source.parent_id === link.page.id || /^\[\[([^|\]]+)(?:\|[^\]]*)?\]\]$/.exec(link.source.text.trim())?.[1] !== id).map(link => link.page.id));
    return { books: works.total, notes: notes.size, capped: backlinks.length >= 1000 };
  });
  const [mergePages] = createResource(() => merging()?.person.id, async id => {
    const library = await props.notebook.api.library({ limit: Number.MAX_SAFE_INTEGER });
    const sources = new Set(library.rows.map(row => row.page.id));
    return props.notebook.roots().filter(page => page.kind === 'page' && page.id !== id && !page.archived && !sources.has(page.id) && titleKey(page.text) !== 'fields');
  });
  const mergedMark = createMemo(() => derivedSourceSiglum([{ id: mergeTarget()?.id ?? null, name: mergeTarget()?.text ?? '', role: 'author' }], '', '').mark);
  const scope = createMemo(() => props.docs.length > 1 ? `Changes the creator links on all ${props.docs.length} sources.` : `Changes only “${props.docs[0]?.root()?.text ?? 'this source'}”.`);
  const countText = createMemo(() => counts.error ? 'Book and atom counts unavailable.' : counts.loading || !counts() ? 'Counting books and linked atoms…' : `${counts()!.books} ${counts()!.books === 1 ? 'book' : 'books'} · ${counts()!.notes}${counts()!.capped ? '+' : ''} linked ${counts()!.notes === 1 && !counts()!.capped ? 'atom' : 'atoms'}`);
  const fail = (reason: unknown) => { const message = reason instanceof Error ? reason.message : String(reason); setError(message); props.onError(message); };
  async function save(value: SourceCreator[]) {
    if (busy() || props.disabled) return;
    setBusy(true); setError(''); props.onError('');
    try { await props.onSave(value); }
    catch (reason) { fail(reason); throw reason; }
    finally { if (!disposed) setBusy(false); }
  }
  async function add(person?: Block) {
    if (!adding() || !name().trim() || busy()) return;
    try {
      await save([...props.value, { id: person?.id ?? null, name: person?.text ?? name().trim(), role: role() }]);
      if (!disposed) { const inside = !!addRow?.contains(document.activeElement); setAdding(false); setName(''); if (inside) focusAddButton(); }
    } catch { /* The unsaved creator remains in place. */ }
  }
  async function move(index: number, direction: -1 | 1) {
    if (busy() || props.disabled) return;
    const creator = props.value[index];
    if (!creator) return;
    let target = index + direction;
    while (target >= 0 && target < props.value.length && props.value[target]!.role !== creator.role) target += direction;
    if (target < 0 || target >= props.value.length) return;
    const reordered = [...props.value];
    [reordered[index], reordered[target]] = [reordered[target]!, creator];
    try {
      await save(reordered);
      if (!disposed) creatorRows.children[target]?.querySelector<HTMLButtonElement>('[aria-keyshortcuts]')?.focus({ preventScroll: true });
    } catch { /* save keeps the failed operation visible in this field. */ }
  }
  async function rename(id: string, title: string) {
    await props.onChange('Person renamed', counts()?.books ?? props.docs.length, async () => {
      const doc = props.notebook.open(id);
      let previous: string;
      try {
        await documentReady(doc);
        previous = doc.root()!.text;
        const result = doc.rename(title);
        if (!result.ok) throw new Error(result.reason);
        await doc.flush();
      } finally { doc.release(); }
      const apply = async (text: string) => {
        const held = props.notebook.open(id);
        try {
          await documentReady(held);
          const result = held.rename(text);
          if (!result.ok) throw new Error(result.reason);
          await held.flush();
        } finally { held.release(); }
      };
      return { undo: () => apply(previous), redo: () => apply(title) };
    });
    setRenaming(undefined);
  }
  function actions(creator: SourceCreator, index: number, anchor: HTMLElement) {
    setPerson(creator);
    setMenu({ anchor, label: `Actions for ${creator.name}`, items: [
      { label: 'Open person', disabledReason: creator.id ? undefined : 'This name is not yet linked to a person.', action: () => { if (creator.id) props.onOpen({ kind: 'page', pageId: creator.id }, false); } },
      { label: 'Rename person', section: 'Changes everywhere', disabledReason: creator.id ? undefined : 'This name is not yet linked to a person.', action: () => { setRenaming(creator.id ?? undefined); } },
      { label: 'Merge into…', disabledReason: creator.id ? undefined : 'This name is not yet linked to a person.', action: () => { if (creator.id) { setMergeTarget(undefined); setQuery(''); setMerging({ person: { ...creator, id: creator.id }, anchor }); } } },
      ...roles.map((item, at) => ({ label: item.label, section: at === 0 ? props.docs.length > 1 ? `Role on these ${props.docs.length} sources` : 'Role on this source' : undefined, checked: creator.role === item.role, action: () => { void save(props.value.map((value, i) => i === index ? { ...value, role: item.role } : value)).catch(() => {}); } })),
      { label: 'Move up', section: `Order among ${creator.role}s`, shortcut: '⌥↑', disabledReason: props.value.slice(0, index).some(value => value.role === creator.role) ? undefined : `Already the first ${creator.role}.`, action: () => { void move(index, -1); } },
      { label: 'Move down', shortcut: '⌥↓', disabledReason: props.value.slice(index + 1).some(value => value.role === creator.role) ? undefined : `Already the last ${creator.role}.`, action: () => { void move(index, 1); } },
      { label: props.docs.length > 1 ? `Remove from these ${props.docs.length} sources` : 'Remove from this source', section: 'Selected links only', action: () => { void save(props.value.filter((_, i) => i !== index)).catch(() => {}); } },
    ] });
  }
  return <div ref={creatorRows} class="metadata-creators">
    <Index each={props.value}>{(creator, index) => <div class="metadata-creator" onKeyDown={event => {
      if (event.defaultPrevented || event.isComposing || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || (event.target as Element).closest('input, textarea, [contenteditable]')) return;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault(); event.stopPropagation(); void move(index, event.key === 'ArrowUp' ? -1 : 1);
      }
    }}>
      <Show when={renaming() === creator().id && !!creator().id} fallback={<div class="metadata-creator-line">
        <Show when={creator().id} fallback={<span>{creator().name}</span>}><Button class="metadata-person-link" onClick={event => props.onOpen({ kind: 'page', pageId: creator().id! }, opensBeside(event))}>{creator().name}</Button></Show>
        <Button class="metadata-role" disabled={busy() || props.disabled} aria-haspopup="menu" aria-label={`Role for ${creator().name}`} onClick={event => setMenu({ anchor: event.currentTarget, label: `Role for ${creator().name}`, items: roles.map(item => ({ label: item.label, checked: creator().role === item.role, action: () => { void save(props.value.map((value, i) => i === index ? { ...value, role: item.role } : value)).catch(() => {}); } })) })}>{roles.find(item => item.role === creator().role)?.label}<Icon name="down" /></Button>
        <Button icon="more" label={`Actions for ${creator().name}`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" disabled={busy() || props.disabled} onClick={event => actions(creator(), index, event.currentTarget)} />
      </div>}>
        <MetadataField label="Person name" startEditing values={[creator().name]} disabled={busy() || props.disabled} scope={`Renames this person everywhere, not only on the selection. ${countText()}`} hint={<p class="metadata-hint">{countText()}. Every book and note linking this person follows the new name.</p>} onSave={value => rename(creator().id!, String(value))} onCancel={() => setRenaming(undefined)} onError={props.onError} />
      </Show>
    </div>}</Index>
    <Show when={adding()} fallback={<Button ref={addButton} class="metadata-empty metadata-add" icon="plus" disabled={busy() || props.disabled} onClick={() => { setName(''); setRole('author'); setAdding(true); }}>Add creator</Button>}>
      <div ref={addRow} class="metadata-add-person" onFocusOut={() => queueMicrotask(() => { if (!disposed && !menu() && !addRow?.contains(document.activeElement)) void add(); })}>
        <div class="metadata-creator-line"><input ref={element => { addInput = element; queueMicrotask(() => { if (element.isConnected) { element.focus(); element.scrollIntoView({ block: 'nearest' }); } }); }} class="input" aria-label="Creator name" placeholder="Creator name" value={name()} disabled={busy() || props.disabled} onInput={event => setName(event.currentTarget.value)} onKeyDown={event => {
          if (event.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); void add(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAdding(false); setError(''); props.onError(''); focusAddButton(); }
        }} /><Button class="metadata-role" aria-haspopup="menu" disabled={busy() || props.disabled} onPointerDown={event => event.preventDefault()} onClick={event => setMenu({ anchor: event.currentTarget, label: 'New creator role', items: roles.map(item => ({ label: item.label, checked: role() === item.role, action: () => { setRole(item.role); queueMicrotask(() => addInput?.focus()); } })) })}>{roles.find(item => item.role === role())?.label}<Icon name="down" /></Button></div>
        <p class="metadata-hint">{scope()}</p>
        <For each={similar()}>{page => <div class="metadata-person-match"><span>Same as <Button class="metadata-person-link" disabled={busy()} onPointerDown={event => event.preventDefault()} onClick={() => { void add(page); }}>{page.text}</Button>?</span><span class="metadata-hint">Choosing this person adds a link; it does not rename them.</span></div>}</For>
      </div>
    </Show>
    <Show when={error()}><p class="metadata-error" role="alert">{error()} This field was not saved.</p></Show>
    <Show when={menu()}>{state => <Menu {...state()} class="metadata-popup" header={<p class="metadata-hint metadata-menu-scope">{scope()}<Show when={person()}><br />{countText()}</Show></p>} onDismiss={() => {
      setMenu(undefined);
      queueMicrotask(() => queueMicrotask(() => { if (!disposed && adding() && !addRow?.contains(document.activeElement)) void add(); }));
    }} />}</Show>
    <Show when={merging()}>{state => <Show when={mergeTarget()} fallback={<Picker<Block> anchor={state().anchor} class="metadata-popup" label="Merge person into" placeholder="Find a person" query={query()} onQuery={setQuery} items={(mergePages() ?? []).filter(page => titleKey(page.text).includes(titleKey(query().trim())))} key={page => page.id} busy={mergePages.loading} error={mergePages.error ? String(mergePages.error) : undefined} empty="No matching people." row={page => <span class="picker-text">{page.text}</span>} onPick={page => setMergeTarget(page)} onDismiss={() => setMerging(undefined)} />}>{target => <Popup anchor={state().anchor} class="metadata-popup metadata-merge" width={400} label="Merge this person?" onDismiss={() => { if (!busy()) setMerging(undefined); }}>
      <h3 class="popup-title">Merge this person?</h3>
      <p class="metadata-merge-names">{state().person.name} → {target().text}</p>
      <p>{countText()}. Books and linked notes follow to {target().text}. Both pages’ notes join there. {state().person.name} stays as an alias.</p>
      <p>Books deriving their mark from this person become <span class="metadata-code">{mergedMark()}</span>, from {target().text}. Authored overrides and book roles stay unchanged.</p>
      <p class="metadata-merge-warning">This changes the person everywhere, not just the selection. The merge is permanent and cannot be undone.</p>
      <Show when={error()}><p class="metadata-error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button disabled={busy()} onClick={() => setMergeTarget(undefined)}>Back</Button><Button class="bordered" disabled={busy() || props.disabled || counts.loading || !!counts.error} onClick={() => {
        setBusy(true); setError('');
        void props.onChange('Person merged', counts()?.books ?? props.docs.length, async () => {
          await props.notebook.mergePage(state().person.id, target().id);
          props.onPermanentChange();
          return undefined;
        }).then(() => { if (!disposed) setMerging(undefined); }).catch(fail).finally(() => { if (!disposed) setBusy(false); });
      }}>Merge person</Button></div>
    </Popup>}</Show>}</Show>
  </div>;
}
