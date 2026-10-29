import { For, Show, createSignal } from 'solid-js';
import type { FieldDefinition, SubjectCriteria } from '../api/types';
import type { PageDocument } from '../document/contract';
import { FieldPicker } from '../fields/FieldPicker';
import { kindLabels } from '../fields/kinds';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import '../fields/fields.css';

export function CriteriaEditor(props: { anchor: HTMLElement; subjectId: string; criteria: SubjectCriteria; fields: readonly FieldDefinition[]; doc: PageDocument; onEdited(doc: PageDocument): void; onDismiss(): void }) {
  const [fields, setFields] = createSignal([...props.criteria.fields]);
  const [picker, setPicker] = createSignal<HTMLElement | null>(null);
  const [error, setError] = createSignal('');
  const revision = props.doc.block(props.subjectId)?.revision ?? 0;
  function move(index: number, by: number) {
    const next = [...fields()];
    const [field] = next.splice(index, 1);
    next.splice(index + by, 0, field!);
    setFields(next);
  }
  function save() {
    const result = props.doc.edit({ kind: 'subjectCriteria', id: props.subjectId, fields: fields(), previous: props.criteria.explicit ? props.criteria.fields : [], revision });
    if (!result.ok) { setError(result.reason); return; }
    props.onEdited(props.doc);
    props.onDismiss();
  }
  const dirty = () => fields().length !== props.criteria.fields.length || fields().some((id, index) => id !== props.criteria.fields[index]);
  return <Popup anchor={props.anchor} label="Edit criteria" class="criteria-editor" width={400} dirty={dirty} onDismiss={props.onDismiss}>
    <h3>Edit criteria</h3>
    <Show when={!props.criteria.explicit}><p class="template-note">Derived from the perspectives' fields</p></Show>
    <ol class="template-fields"><For each={fields()}>{(id, index) => {
      const field = props.fields.find(field => field.id === id);
      return <li class="template-field"><Icon name="field" /><span class="template-field-name">{field?.name ?? 'Unavailable field'}</span><span class="template-field-kind">{field ? kindLabels[field.kind] : ''}</span>
        <span class="template-field-actions">
          <Button icon="up" label={`Move ${field?.name} up`} disabled={index() === 0} onClick={() => move(index(), -1)} />
          <Button icon="down" label={`Move ${field?.name} down`} disabled={index() === fields().length - 1} onClick={() => move(index(), 1)} />
          <Button icon="close" label={`Remove ${field?.name} from criteria`} onClick={() => setFields(fields => fields.filter(value => value !== id))} />
        </span></li>;
    }}</For></ol>
    <Show when={error()}><p class="pane-error" role="alert">{error()}</p></Show>
    <div class="criteria-editor-actions"><Button icon="plus" onClick={event => setPicker(event.currentTarget)}>Add field</Button><Button onClick={props.onDismiss}>Cancel</Button><Button class="bordered" onClick={save}>Save</Button></div>
    <Show when={picker()}>{anchor => <FieldPicker anchor={anchor()} label="Add criterion" fields={props.fields} exclude={new Set(fields())} onPick={field => { setFields(fields => [...fields, field.id]); setPicker(null); }} onDismiss={() => setPicker(null)} />}</Show>
  </Popup>;
}
