import { createMemo, createResource, createSignal } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { Picker } from '../ui/Picker';
import { Icon } from '../ui/Icon';

/** Recovery reads retained deletion events, not a window-local undo stack. */
export function DeletedPages(props: { anchor: HTMLElement; notebook: NotebookClient; onDismiss(): void; onRestored(id: string): void }) {
  const [pages] = createResource(() => props.notebook.api.deletedPages());
  const [query, setQuery] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const matches = createMemo(() => {
    if (pages.error) return [];
    const words = query().trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return (pages() ?? []).filter(page => words.every(word => page.block.text.toLocaleLowerCase().includes(word)));
  });
  return <Picker anchor={props.anchor} label="Restore deleted atom" query={query()} onQuery={setQuery} placeholder="Find a deleted atom…"
    items={matches()} key={page => page.block.id} busy={pages.loading || busy()} error={error() || (pages.error ? String(pages.error) : '')}
    empty="No deleted atoms" onDismiss={props.onDismiss} disabledReason={() => busy() ? 'Restoring atom…' : undefined}
    row={page => <><Icon name={page.block.kind === 'journal' ? 'today' : 'page'} /><span class="picker-row-title">{page.block.text}</span><span class="muted">Deleted {new Date(page.deleted_at).toLocaleDateString()}</span></>}
    onPick={page => {
      if (busy()) return;
      setBusy(true); setError('');
      void props.notebook.restorePage(page.block.id).then(() => props.onRestored(page.block.id)).catch(reason => {
        setBusy(false); setError(reason instanceof Error ? reason.message : String(reason));
      });
    }} />;
}
