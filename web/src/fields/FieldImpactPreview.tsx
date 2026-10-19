import { For, Show, createSignal } from 'solid-js';
import type { FieldImpact } from './commands';
import type { FieldDefinition } from '../api/types';
import { Button } from '../ui/Button';
import { FieldPicker } from './FieldPicker';
import { plural } from '../sync/state';

export function FieldImpactPreview(props: { impact: FieldImpact; fields: readonly FieldDefinition[]; busy: boolean; onTarget(id: string): void; onApply(action: 'archive' | 'merge' | 'detach' | 'delete'): void; onCancel(): void }) {
  const [picker, setPicker] = createSignal<HTMLElement>();
  const [confirmed, setConfirmed] = createSignal(false);
  return <section class="field-section" aria-label="Field impact">
    <h2 class="field-section-head">{props.impact.target ? `Merge into ${props.impact.target.field.name}` : `Delete ${props.impact.detail.field.name}`}</h2>
    <p class="field-note">{plural(props.impact.detail.owners_total, 'owner')} on {plural(new Set(props.impact.entries.map(entry => entry.page_id)).size, 'atom')}; {plural(props.impact.templates.length, 'template')}; {plural(props.impact.views.length, 'view')}.</p>
    <details><summary>Affected atoms</summary><ul class="field-note"><For each={props.impact.pages.filter(page => page.root.id !== props.impact.definition.page_id)}>{page => <li>{page.root.text}</li>}</For></ul></details>
    <details><summary>Affected templates</summary><ul class="field-note"><For each={props.impact.templates} fallback={<li>No templates.</li>}>{type => <li>{type.page.text}</li>}</For></ul></details>
    <details open><summary>Affected views</summary><ul class="field-note"><For each={props.impact.views} fallback={<li>No views.</li>}>{view => <li>{view.name}</li>}</For></ul></details>
    <Show when={props.impact.target} fallback={<>
      <p class="field-note">Archive hides this definition from pickers and keeps its values readable. Detach keeps values as ordinary text. Delete values removes their subtrees.</p>
      <Button disabled={props.busy || props.impact.definition.archived} onClick={() => props.onApply('archive')}>Archive</Button>
      <Show when={props.impact.definition.archived}><p class="field-note">This definition is already archived.</p></Show>
      <Button disabled={props.busy} onClick={() => props.onApply('detach')}>Detach</Button>
      <label class="menu-item"><input type="checkbox" checked={confirmed()} onChange={event => setConfirmed(event.currentTarget.checked)} />Delete every value and its child atoms</label>
      <Button disabled={props.busy || !confirmed()} onClick={() => props.onApply('delete')}>Delete values</Button>
      <Show when={!confirmed()}><p class="field-note">Confirm above to delete values.</p></Show>
    </>}>
      <p class="field-note">{plural(new Set(props.impact.conflicts.map(entry => entry.parent_id)).size, 'owner')} {new Set(props.impact.conflicts.map(entry => entry.parent_id)).size === 1 ? 'has' : 'have'} both fields. Their values stay side by side as separate entries.</p>
      <Show when={props.impact.conflicts.length}><details open><summary>Conflicting values</summary><ul class="field-note"><For each={props.impact.conflicts}>{entry => {
        const page = props.impact.pages.find(page => page.root.id === entry.page_id)!;
        const owner = page.root.id === entry.parent_id ? page.root : page.rows.find(row => row.block.id === entry.parent_id)?.block;
        const entries = new Set(page.rows.filter(row => row.block.parent_id === entry.parent_id && (row.block.text === `[[${props.impact.definition.id}]]` || row.block.text === `[[${props.impact.target!.field.id}]]`)).map(row => row.block.id));
        return <li>{owner?.text ?? page.root.text}: {page.rows.filter(row => entries.has(row.block.parent_id ?? '')).map(row => row.block.text).join(' · ')}</li>;
      }}</For></ul></details></Show>
      <Button class="bordered" disabled={props.busy} onClick={() => props.onApply('merge')}>Apply merge</Button>
    </Show>
    <div class="field-preview-actions"><Button disabled={props.busy} onClick={event => setPicker(event.currentTarget)}>Merge into…</Button><Button disabled={props.busy} onClick={props.onCancel}>Cancel</Button></div>
    <Show when={picker()}>{anchor => <FieldPicker anchor={anchor()} label="Merge into" fields={props.fields} exclude={new Set([props.impact.definition.id])} onPick={field => { setPicker(undefined); props.onTarget(field.id); }} onDismiss={() => setPicker(undefined)} />}</Show>
  </section>;
}
