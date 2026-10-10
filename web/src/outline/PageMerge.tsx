import { createMemo, createResource, createSignal, Show } from 'solid-js';
import type { Block } from '../api/types';
import type { BlockState, NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';

type Page = Pick<Block, 'id' | 'text'>;

export function pageMergeDisabledReason(root: BlockState | undefined): string | undefined {
  if (!root) return 'Page is still loading.';
  if (root.source) return 'Sources cannot merge.';
  if (root.kind !== 'page') return 'Only titled pages can merge.';
  if (root.text.toLocaleLowerCase() === 'fields') return 'Fields cannot merge.';
  if (root.mergeProtected || root.citations.length) return 'This page has root state that cannot move in a merge.';
  return undefined;
}

/** Both the title collision and page menu require the same permanent confirmation. */
export function PageMergeConfirmation(props: { anchor: PopupAnchor; notebook: NotebookClient; from: Page; into: Page; onDismiss(): void; onMerged(id: string): void }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const merge = async () => {
    if (busy()) return;
    setBusy(true); setError('');
    try {
      await props.notebook.mergePage(props.from.id, props.into.id);
      props.onMerged(props.into.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  return <Popup anchor={props.anchor} label={`Merge “${props.from.text}” into “${props.into.text}”?`} onDismiss={() => { if (!busy()) props.onDismiss(); }}>
    <h3>Merge “{props.from.text}” into “{props.into.text}”?</h3>
    <p class="muted">References and blocks will move to “{props.into.text}”. This merge is permanent.</p>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <Show when={busy()}><p class="muted" role="status">Waiting for the merge to save.</p></Show>
    <div class="popup-actions"><Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button><Button class="danger bordered" disabled={busy()} onClick={() => { void merge(); }}>Merge pages</Button></div>
  </Popup>;
}

export function PageMergePicker(props: { anchor: PopupAnchor; notebook: NotebookClient; from: Page; onDismiss(): void; onMerged(id: string): void }) {
  const [query, setQuery] = createSignal('');
  const [target, setTarget] = createSignal<Block>();
  const [pages] = createResource(() => {
    props.notebook.changeSequence();
    return props.notebook.roots().filter(page => page.kind === 'page' && page.id !== props.from.id && page.text.trim() && page.text.toLocaleLowerCase() !== 'fields');
  }, async roots => {
    const library = await props.notebook.api.library({ limit: roots.length });
    const sources = new Set(library.rows.map(row => row.source.block_id));
    return roots.filter(page => !sources.has(page.id));
  });
  const matches = createMemo(() => {
    const text = query().trim().toLocaleLowerCase();
    return pages.error ? [] : (pages() ?? []).filter(page => page.text.toLocaleLowerCase().includes(text));
  });
  return <Show keyed when={target()} fallback={<Picker<Block> anchor={props.anchor} label="Merge into" onDismiss={props.onDismiss}
    query={query()} onQuery={setQuery} placeholder="Find a page" items={matches()} key={page => page.id}
    onPick={page => setTarget(page)} busy={pages.loading} error={pages.error ? String(pages.error) : undefined} empty="No matching pages."
    row={page => <><Icon name="page" /><span class="picker-text">{page.text}</span></>} />}>
    {into => <PageMergeConfirmation anchor={props.anchor} notebook={props.notebook} from={props.from} into={into} onDismiss={props.onDismiss} onMerged={props.onMerged} />}
  </Show>;
}
