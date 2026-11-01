import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { SOURCE_TARGET, typeTargets } from './targets';
import { titleKey } from '../document/title-key';

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
    // Source stands for every source, so a type page of the same name would only repeat it; keep one only when it is already a target.
    for (const page of props.notebook.roots()) if (page.kind === 'page' && !page.archived && (['person', 'group'].includes(titleKey(page.text)) || props.targets.includes(page.id))) pages.set(page.id, page);
    for (const [id, page] of pages) if (titleKey(page.text) === 'source' && !props.targets.includes(id)) pages.delete(id);
    return [{ id: SOURCE_TARGET, text: 'Source' }, ...[...pages.values()].sort((a, b) => a.text.localeCompare(b.text))];
  });
  return <Popup anchor={props.anchor} label="Links to" fitContent ready={types.state !== 'pending' && types.state !== 'unresolved'} dirty={() => draft().length !== props.targets.length || draft().some(id => !props.targets.includes(id))} onDismiss={props.onDismiss}>
    <h2 class="popup-title">Links to</h2><p class="field-note">No selection means Any atom.</p>
    <Show when={types.error}><p class="error" role="alert">Could not load tags.</p></Show>
    <For each={choices()}>{type => <button type="button" role="checkbox" aria-checked={draft().includes(type.id)} class="menu-item links-to-choice" onClick={() => setDraft(previous => previous.includes(type.id) ? previous.filter(id => id !== type.id) : [...previous, type.id])}><span class="field-checkbox" aria-hidden="true"><Show when={draft().includes(type.id)}><Icon name="check" /></Show></span>{type.text}</button>}</For>
    <div class="popup-actions"><Button onClick={() => props.onDismiss()}>Cancel</Button><Button class="bordered" disabled={props.disabled} onClick={() => props.onApply(draft().includes(SOURCE_TARGET) ? [SOURCE_TARGET, ...typeTargets(draft())] : draft())}>Apply</Button></div>
  </Popup>;
}
