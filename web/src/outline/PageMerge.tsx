import { createMemo, createResource, createSignal, Show } from 'solid-js';
import type { Block, BlockCapabilities } from '../api/types';
import type { BlockState, NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';

type Page = Pick<Block, 'id' | 'text'>;

export function builtInTagReason(title: string, capabilities: Pick<BlockCapabilities, 'built_in_tag'> | undefined, action: 'delete' | 'merge'): string | undefined {
  if (!capabilities?.built_in_tag) return undefined;
  const name = title[0]!.toLocaleUpperCase() + title.slice(1).toLocaleLowerCase();
  return `${name} is a built-in tag; ${action === 'delete' ? 'its page cannot be deleted.' : 'its page cannot merge.'}`;
}

export function pageMergeDisabledReason(root: BlockState | undefined, capabilities?: Pick<BlockCapabilities, 'built_in_tag'>): string | undefined {
  if (!root) return 'Page is still loading.';
  const system = builtInTagReason(root.text, capabilities, 'merge');
  if (system) return system;
  if (root.source) return 'Sources cannot merge.';
  if (root.kind !== 'page') return 'Only titled pages can merge.';
  if (root.text.toLocaleLowerCase() === 'fields') return 'Fields cannot merge.';
  if (root.spread) return "A spread can't be merged.";
  if (root.project) return "A project can't be merged.";
  if (root.task) return "A page with a task can't be merged.";
  if (root.question) return "A question page can't be merged.";
  if (root.position) return "A perspective page can't be merged.";
  if (root.assessment) return "A page with an assessment can't be merged.";
  if (root.relation) return "A page with an argument can't be merged.";
  if (root.quote) return "A page with a quoted copy can't be merged.";
  if (root.citations.length) return "A page with citations on its title can't be merged.";
  if (root.reviewedCards) return "A page with card review history can't be merged.";
  if (root.templateCards) return "A page with card templates can't be merged.";
  if (root.mergeProtected) return "A page with task or review history can't be merged.";
  return undefined;
}

/** Both the title collision and page menu require the same permanent confirmation. */
export function PageMergeConfirmation(props: { anchor: PopupAnchor; notebook: NotebookClient; from: Page; into: Page; onDismiss(): void; onMerged(id: string): void }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [capabilities] = createResource(() => props.from.id, id => props.notebook.api.capabilities(id));
  const disabled = () => capabilities.error ? String(capabilities.error) : !capabilities() ? 'Page is still loading.' : builtInTagReason(props.from.text, capabilities(), 'merge');
  const merge = async () => {
    if (busy()) return;
    if (disabled()) { setError(disabled()!); return; }
    setBusy(true); setError('');
    try {
      await props.notebook.mergePage(props.from.id, props.into.id);
      props.onMerged(props.into.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  return <Popup anchor={props.anchor} class="outline-capability-popup page-merge-confirmation" label={`Merge “${props.from.text}” into “${props.into.text}”?`} onDismiss={() => { if (!busy()) props.onDismiss(); }}>
    <h3 class="popup-title">Merge “{props.from.text}” into “{props.into.text}”?</h3>
    <p class="muted">References and atoms will move to “{props.into.text}”. This merge is permanent. “{props.from.text}” stays as an alias.</p>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <Show when={busy()}><p class="muted" role="status">Waiting for the merge to save.</p></Show>
    <div class="popup-actions"><Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button><Button class="danger bordered" disabled={busy() || !!disabled()} title={disabled()} onClick={() => { void merge(); }}>Merge pages</Button></div>
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
