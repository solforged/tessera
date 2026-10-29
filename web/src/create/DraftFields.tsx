import { For, Match, Show, Switch, createMemo, createResource, createSignal } from 'solid-js';
import type { CardTemplateInfo, FieldDefinition } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { checkboxValue } from '../fields/kinds';
import { PlainValueInput, ValueEditor } from '../fields/value-editor';
import { hasValueEditor } from '../fields/value-options';
import { BlockText } from '../outline/BlockText';
import { entityLabel } from '../outline/holders';
import { holderChoices } from '../outline/RelationActions';
import type { HolderChoice } from '../outline/RelationActions';
import { QuestionParentPicker } from '../outline/Questions';
import { DatePicker } from '../tasks/DatePicker';
import { parseTaskDate } from '../tasks/date-input';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import type { CreateKind } from './request';
import { draftFieldRows } from './draft';
import type { DraftFieldsState, DraftValue } from './draft';
import { draftPattern } from '../fields/card-patterns';
import { parseCardText } from '../review/card-text';
import { trackSlipLoading } from './slip-loading';

type Editing = { anchor: HTMLElement } & ({ kind: 'parent' | 'revisit' | 'review-date' | 'deadline' | 'holder' } | { kind: 'value'; field: FieldDefinition });

export function DraftFields(props: {
  notebook: NotebookClient; kind: CreateKind; fieldIds: readonly string[]; existingId?: string; disabled: boolean;
  value: DraftFieldsState; onChange(value: DraftFieldsState): void;
  recipes?: readonly CardTemplateInfo[]; atomText?: string;
}) {
  const [editing, setEditing] = createSignal<Editing>();
  const [error, setError] = createSignal('');
  const [register] = createResource(() => props.kind.startsWith('type:') && props.fieldIds.length ? props.notebook.changeSequence() : false, () => props.notebook.api.fields());
  const [page] = createResource(() => props.existingId ? [props.existingId, props.notebook.changeSequence()] as const : false, async ([id]) => ({ id, page: await props.notebook.api.page(id) }));
  const definitions = createMemo(() => (props.recipes?.length ? props.fieldIds : props.fieldIds.slice(0, 4)).flatMap(id => register()?.fields.find(field => field.id === id) ?? []));
  trackSlipLoading(() => register.loading || page.loading);
  const existing = (field: FieldDefinition) => draftFieldRows(props.existingId && page()?.id === props.existingId ? page()!.page.rows.map(row => row.block) : [], props.existingId ?? '', field.id);
  const setValue = (field: FieldDefinition, value: DraftValue) => props.onChange({ ...props.value, values: { ...props.value.values, [field.id]: value } });
  const question = (value: Partial<DraftFieldsState['question']>) => props.onChange({ ...props.value, question: { ...props.value.question, ...value } });
  const dismiss = () => { const anchor = editing()?.anchor; setEditing(undefined); queueMicrotask(() => anchor?.focus({ preventScroll: true })); };
  const open = (value: Editing) => { setError(''); setEditing(value); };
  const previews = createMemo(() => {
    const syntax = parseCardText(props.atomText ?? '');
    if (syntax.cards.length || syntax.problems.length) return [];
    const values = Object.fromEntries(definitions().map(field => {
      const current = existing(field), draft = props.value.values[field.id];
      const text = current.filled ? current.values.map(value => value.text).join(', ') : draft?.option ?? draft?.relationPick?.query ?? draft?.text ?? '';
      const reference = text.match(/^\[\[([0-9A-Z]{26})\]\]$/)?.[1];
      return [field.id, reference ? field.options.find(option => option.id === reference)?.text ?? props.notebook.lookup(reference)()?.text ?? text : text];
    }));
    return (props.recipes ?? []).map(recipe => ({ recipe, front: draftPattern(recipe.front, props.atomText ?? '', values), back: draftPattern(recipe.back, props.atomText ?? '', values) }));
  });
  const row = (label: string, text: string | undefined | null, kind: Exclude<Editing['kind'], 'value'>) => <Button class="create-field-row" disabled={props.disabled} onClick={event => open({ kind, anchor: event.currentTarget })}>
    <span class="create-field-label">{label}</span><span class="create-field-value" classList={{ 'create-field-empty': !text }}><Show when={text} fallback="Add…"><BlockText text={text!} notebook={props.notebook} interactive={false} /></Show></span>
  </Button>;
  return <div class="create-fields" classList={{ 'create-recipe-fields': !!props.recipes?.length }} onKeyDown={event => { if (!event.metaKey && !event.ctrlKey) event.stopPropagation(); }}>
    <Show when={props.kind === 'question'}>
      {row('Parent question', props.value.question.parent ? `[[${props.value.question.parent}]]` : null, 'parent')}
      {row('Revisit', props.value.question.review_on, 'revisit')}
      <Button class="create-field-row" role="checkbox" aria-checked={props.value.question.unsettled} disabled={props.disabled} onClick={() => question({ unsettled: !props.value.question.unsettled })}>
        <span class="create-field-label">Recurrent</span><span class="create-field-value"><Icon name={props.value.question.unsettled ? 'check' : 'stop'} /></span>
      </Button>
      {row('First perspective', props.value.holder?.text, 'holder')}
    </Show>
    <Show when={props.kind === 'project'}>{row('Deadline', props.value.deadline, 'deadline')}</Show>
    <Show when={props.kind.startsWith('type:')}><For each={definitions()}>{field => {
      const current = () => existing(field);
      const text = () => {
        if (current().filled) return current().values.filter(value => value.text.trim()).map(value => value.text).join(', ');
        const draft = props.value.values[field.id];
        return draft?.relationPick && !draft.relationPick.targetId ? draft.relationPick.query : draft?.text ?? '';
      };
      return <Show when={props.recipes?.length && field.kind === 'text'} fallback={<Button class="create-field-row" disabled={props.disabled || current().filled || !!props.existingId && page.loading} onClick={event => {
        if (field.kind === 'checkbox') setValue(field, { text: checkboxValue(text()) ? 'no' : 'yes' });
        else open({ kind: 'value', field, anchor: event.currentTarget });
      }}><span class="create-field-label">{field.name}</span><span class="create-field-value" classList={{ 'create-field-empty': !text() }}>
        <Show when={text()} fallback="Add…"><Show when={field.kind === 'checkbox'} fallback={<BlockText text={text()} notebook={props.notebook} interactive={false} />}><Icon name={checkboxValue(text()) ? 'check' : 'stop'} /></Show></Show>
      </span></Button>}><label class="create-field-row create-field-input"><span class="create-field-label">{field.name}</span><input aria-label={field.name} value={text()} placeholder="Add…" disabled={props.disabled || current().filled} onInput={event => setValue(field, { text: event.currentTarget.value })} /></label></Show>;
    }}</For><Show when={props.fieldIds.length > 4 && !props.recipes?.length}><p class="create-fields-more">More fields after creating</p></Show></Show>
    <Show when={props.recipes?.length}><section class="create-card-preview" aria-label="Cards"><div class="create-card-head"><span class="ct-marker">01</span><span>Cards</span><span class="section-rule" /><span>{previews().filter(preview => preview.front && preview.back).length}</span></div><div class="create-card-directions"><For each={previews()}>{preview => <div><span class="create-field-label">{preview.recipe.name}</span><p>{preview.front ?? 'Waiting for the front'}</p><p>{preview.back ?? 'Waiting for the answer'}</p></div>}</For></div><Show when={!previews().length}><p class="create-fields-more">This atom keeps its syntax cards instead.</p></Show></section></Show>
    <Show when={error() || register.error || page.error}><p class="error" role="alert">{error() || String(register.error ?? page.error)}</p></Show>
    <Show keyed when={editing()}>{state => <Switch>
      <Match when={state.kind === 'parent'}><QuestionParentPicker id={props.existingId ?? ''} notebook={props.notebook} anchor={state.anchor} onDismiss={dismiss} onPick={async parent => { question({ parent }); }} /></Match>
      <Match when={state.kind === 'revisit'}><Menu anchor={state.anchor} label="Revisit" title="Revisit" onDismiss={dismiss} items={[
        ...[{ label: 'In a week', input: '+7d' }, { label: 'In a month', input: '+1m' }, { label: 'In three months', input: '+3m' }].map(preset => ({ label: preset.label, action: () => { const parsed = parseTaskDate(preset.input, props.notebook.todayDate()); if (parsed.ok) question({ review_on: parsed.date }); else setError(parsed.error); } })),
        { label: 'On a date…', action: () => open({ kind: 'review-date', anchor: state.anchor }) },
        { label: 'None', action: () => question({ review_on: null }) },
      ]} /></Match>
      <Match when={state.kind === 'review-date' || state.kind === 'deadline'}><DatePicker notebook={props.notebook} anchor={state.anchor} label={state.kind === 'deadline' ? 'Deadline' : 'Revisit'} contextDate={props.notebook.todayDate()} value={state.kind === 'deadline' ? props.value.deadline : props.value.question.review_on} onDismiss={dismiss}
        onSelect={value => { if (state.kind === 'deadline') props.onChange({ ...props.value, deadline: value.date }); else question({ review_on: value.date }); }} /></Match>
      <Match when={state.kind === 'holder'}><HolderPicker notebook={props.notebook} anchor={state.anchor} onDismiss={dismiss} onPick={choice => { props.onChange({ ...props.value, holder: { id: choice.block.id, text: choice.block.text, create: choice.create, file: choice.file } }); dismiss(); }} /></Match>
      <Match when={state.kind === 'value' ? state : undefined}>{value => {
        const field = value().field;
        const text = () => props.value.values[field.id]?.text ?? '';
        return <Show when={hasValueEditor(field, text(), props.notebook.todayDate())} fallback={<PlainDraftValue field={field} text={text()} anchor={state.anchor} onDismiss={dismiss} onWrite={text => setValue(field, { text })} />}>
          <ValueEditor notebook={props.notebook} anchor={state.anchor} field={field} text={text()} contextDate={props.notebook.todayDate()} owner={props.existingId ? { id: props.existingId, page: props.existingId } : undefined}
            onDismiss={dismiss} onError={setError} onWrite={(text, relationPick) => setValue(field, { text, relationPick })} onCreateOption={async option => { setValue(field, { text: option, option }); }} />
        </Show>;
      }}</Match>
    </Switch>}</Show>
  </div>;
}

function PlainDraftValue(props: { field: FieldDefinition; text: string; anchor: HTMLElement; onWrite(text: string): void; onDismiss(): void }) {
  const [text, setText] = createSignal(props.text);
  let cancelled = false;
  const commit = (close: boolean) => { if (!cancelled) { props.onWrite(text()); if (close) props.onDismiss(); } };
  return <Popup anchor={props.anchor} label={props.field.name} onDismiss={() => { commit(false); props.onDismiss(); }}>
    <PlainValueInput field={props.field} text={text()} onInput={setText} onCommit={commit} onCancel={() => { cancelled = true; props.onDismiss(); }} />
    <div class="popup-actions"><Button class="bordered" onClick={() => commit(true)}>Done</Button></div>
  </Popup>;
}

function HolderPicker(props: { notebook: NotebookClient; anchor: HTMLElement; onDismiss(): void; onPick(choice: HolderChoice): void }) {
  const [query, setQuery] = createSignal('');
  const [choices] = createResource(() => [query(), props.notebook.changeSequence()] as const, ([text]) => holderChoices(props.notebook, text));
  return <Picker anchor={props.anchor} label="First perspective" query={query()} onQuery={setQuery} placeholder="Find a person or group" items={choices() ?? []} key={choice => `${choice.block.id}:${choice.create ?? choice.file ?? ''}`} section={choice => choice.section}
    onDismiss={props.onDismiss} onPick={props.onPick} busy={choices.loading} error={choices.error ? String(choices.error) : undefined} empty="No matching destinations."
    row={choice => <><Icon name={choice.create || choice.file ? 'plus' : 'note'} /><span class="picker-text"><Show when={choice.create}>{kind => <>Create {entityLabel(kind())} “</>}</Show><Show when={choice.file}>File “</Show><BlockText text={choice.block.text} notebook={props.notebook} interactive={false} /><Show when={choice.create}>”</Show><Show when={choice.file}>{kind => <>” as {entityLabel(kind())}</>}</Show></span><Show when={choice.alias}><span class="reference-via">via {choice.alias}</span></Show></>} />;
}
