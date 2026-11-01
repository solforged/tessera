import { For, Show, createSignal } from 'solid-js';
import type { FieldImpact } from './commands';
import type { FieldDefinition } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { displayTitle, plainText } from '../outline/names';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { FieldPicker } from './FieldPicker';
import { fieldLabel } from './kinds';
import { plural } from '../sync/state';

/** Names beyond this many collapse to a count, so a field used on hundreds of atoms keeps its panel bounded. */
const SHOWN = 8;

function Names(props: { label: string; names: string[]; none: string }) {
  return <div class="field-impact-row">
    <dt>{props.label}</dt>
    <dd><Show when={props.names.length} fallback={<span class="field-impact-none">{props.none}</span>}>{props.names.slice(0, SHOWN).join(' · ')}<Show when={props.names.length > SHOWN}><span class="field-impact-none"> · and {props.names.length - SHOWN} more</span></Show></Show></dd>
  </div>;
}

export function FieldImpactPreview(props: { impact: FieldImpact; fields: readonly FieldDefinition[]; notebook: NotebookClient; busy: boolean; onTarget(id: string): void; onApply(action: 'archive' | 'merge' | 'detach' | 'delete'): void; onCancel(): void }) {
  const [picker, setPicker] = createSignal<HTMLElement>();
  const [confirmed, setConfirmed] = createSignal(false);
  const lookup: NotebookClient['lookup'] = id => props.notebook.lookup(id);
  const owners = () => new Set(props.impact.conflicts.map(entry => entry.parent_id)).size;
  return <section class="field-impact" aria-label="Field impact">
    <h2 class="field-impact-title">{props.impact.target ? `Merge into ${fieldLabel(props.impact.target.field)}` : 'Delete definition'}</h2>
    <p class="field-impact-summary">{plural(props.impact.detail.owners_total, 'owner')} on {plural(new Set(props.impact.entries.map(entry => entry.page_id)).size, 'atom')} · {plural(props.impact.templates.length, 'template')} · {plural(props.impact.views.length, 'view')}</p>
    <dl class="field-impact-list">
      <Names label="Atoms" none="None" names={props.impact.pages.filter(page => page.root.id !== props.impact.definition.page_id).map(page => displayTitle(page.root.text, lookup))} />
      <Names label="Templates" none="None" names={props.impact.templates.map(type => displayTitle(type.page.text, lookup))} />
      <Names label="Views" none="None" names={props.impact.views.map(view => view.name)} />
    </dl>
    <Show when={props.impact.target} fallback={<div class="field-impact-actions">
      <div class="field-impact-action">
        <p>Archive hides this definition from pickers and keeps its values readable.<Show when={props.impact.definition.archived}> It is already archived.</Show></p>
        <Button class="bordered" disabled={props.busy || props.impact.definition.archived} onClick={() => props.onApply('archive')}>Archive</Button>
      </div>
      <div class="field-impact-action">
        <p>Detach keeps values as ordinary text and removes the definition.</p>
        <Button class="bordered" disabled={props.busy} onClick={() => props.onApply('detach')}>Detach</Button>
      </div>
      <div class="field-impact-action">
        <label class="field-impact-confirm"><input type="checkbox" checked={confirmed()} onChange={event => setConfirmed(event.currentTarget.checked)} />Delete every value and its child atoms</label>
        <Button class="bordered danger" disabled={props.busy || !confirmed()} onClick={() => props.onApply('delete')}>Delete values</Button>
      </div>
    </div>}>
      <p class="field-impact-merge">{plural(owners(), 'owner')} {owners() === 1 ? 'has' : 'have'} both fields. Their values stay side by side as separate entries.</p>
      <Show when={props.impact.conflicts.length}><ul class="field-impact-conflicts"><For each={props.impact.conflicts}>{entry => {
        const page = props.impact.pages.find(page => page.root.id === entry.page_id)!;
        const owner = page.root.id === entry.parent_id ? page.root : page.rows.find(row => row.block.id === entry.parent_id)?.block;
        const entries = new Set(page.rows.filter(row => row.block.parent_id === entry.parent_id && (row.block.text === `[[${props.impact.definition.id}]]` || row.block.text === `[[${props.impact.target!.field.id}]]`)).map(row => row.block.id));
        return <li>{plainText(owner?.text ?? page.root.text, lookup)}: {page.rows.filter(row => entries.has(row.block.parent_id ?? '')).map(row => plainText(row.block.text, lookup)).join(' · ')}</li>;
      }}</For></ul></Show>
    </Show>
    <div class="field-impact-foot">
      <Button disabled={props.busy} aria-haspopup="dialog" onClick={event => setPicker(event.currentTarget)}>Merge into… <Icon name="down" /></Button>
      <span class="field-impact-gap" />
      <Button disabled={props.busy} onClick={props.onCancel}>Cancel</Button>
      <Show when={props.impact.target}><Button class="bordered" disabled={props.busy} onClick={() => props.onApply('merge')}>Apply merge</Button></Show>
    </div>
    <Show when={picker()}>{anchor => <FieldPicker anchor={anchor()} label="Merge into" fields={props.fields} exclude={new Set([props.impact.definition.id])} onPick={field => { setPicker(undefined); props.onTarget(field.id); }} onDismiss={() => setPicker(undefined)} />}</Show>
  </section>;
}
