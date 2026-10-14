import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { SOURCE_TARGET, typeTargets } from './targets';

/**
 * Chooses what a relation field links to: sources, which are a capability rather than a type, and types. Every type
 * is offered, with Person and Group even before they have members, and the current targets even if they are no
 * longer types. No selection means any block.
 */
export function LinksToPopup(props: { anchor: HTMLElement; notebook: NotebookClient; targets: readonly string[]; disabled?: boolean; onApply(targets: string[]): void; onDismiss(): void }) {
  const [draft, setDraft] = createSignal([...props.targets]);
  const [types] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.types());
  const choices = createMemo(() => {
    const pages = new Map((types() ?? []).map(type => [type.page.id, type.page]));
    for (const page of props.notebook.roots()) if (page.kind === 'page' && !page.archived && (['person', 'group'].includes(page.text.toLowerCase()) || props.targets.includes(page.id))) pages.set(page.id, page);
    return [{ id: SOURCE_TARGET, text: 'Source' }, ...[...pages.values()].sort((a, b) => a.text.localeCompare(b.text))];
  });
  return <Popup anchor={props.anchor} label="Links to" onDismiss={props.onDismiss}>
    <h2 class="popup-title">Links to</h2><p class="field-note">No selection means Any block.</p>
    <Show when={types.error}><p class="error" role="alert">Could not load types.</p></Show>
    <For each={choices()}>{type => <label class="menu-item"><input type="checkbox" checked={draft().includes(type.id)} onChange={event => { const checked = event.currentTarget.checked; setDraft(previous => checked ? [...previous, type.id] : previous.filter(id => id !== type.id)); }} />{type.text}</label>}</For>
    <div class="popup-actions"><Button onClick={() => props.onDismiss()}>Cancel</Button><Button class="bordered" disabled={props.disabled} onClick={() => props.onApply(draft().includes(SOURCE_TARGET) ? [SOURCE_TARGET, ...typeTargets(draft())] : draft())}>Apply</Button></div>
  </Popup>;
}
