import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from 'solid-js';
import { ulid } from 'ulid';
import type { CardTemplateInfo, CardTemplateState, FieldDefinition } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { FieldsViewState, OpenTarget } from '../shell/contract';
import { opensBeside } from '../shell/beside';
import { typeQuery } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { TypeModeTabs } from '../ui/TypeModeTabs';
import { noteIndex } from '../notes/kinds';
import { displayPattern, storedPattern } from './card-patterns';
import { convertSyntax, syntaxAtom } from './recipe-conversion';
import { parseCardText } from '../review/card-text';
import './card-templates.css';

interface Props {
  typeId: string; applyId?: string; notebook: NotebookClient; view: FieldsViewState;
  onActivate(): void; onOpen(target: OpenTarget, beside: boolean): void; onViewChange(view: FieldsViewState): void;
}

export function CardTemplatesPane(props: Props) {
  const index = noteIndex(props.notebook);
  const kind = createMemo(() => index()?.kinds.find(value => value.type_id === props.typeId));
  const [type] = createResource(() => [props.typeId, props.notebook.changeSequence()] as const, ([id]) => props.notebook.api.type(id));
  let scroll!: HTMLDivElement;
  onMount(() => { scroll.scrollTop = props.view.scroll; scroll.focus({ preventScroll: true }); });
  return <div ref={scroll} class="card-templates-pane" role="region" aria-label={`${type()?.page.text ?? 'Tag'} cards`} tabIndex={0} onFocusIn={props.onActivate} onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })}>
    <div class="ct-sheet"><header class="ct-heading"><div class="ct-title-row"><h1>{type()?.page.text ?? 'Cards'}</h1><Button onClick={event => props.onOpen({ kind: 'page', pageId: props.typeId }, opensBeside(event))}>Open tag</Button></div></header>
      <TypeModeTabs active="cards" indexCount={kind()?.count} tableCount={type()?.members} fieldsCount={type()?.fields.length} cardsCount={type()?.card_templates}
        onIndex={event => props.onOpen({ kind: 'index', key: kind()?.key ?? `type:${props.typeId}` }, opensBeside(event))}
        onTable={event => props.onOpen({ kind: 'table', typeId: props.typeId, viewId: null, query: typeQuery(props.typeId) }, opensBeside(event))}
        onFields={event => props.onOpen({ kind: 'fields', typeId: props.typeId }, opensBeside(event))} onCards={() => {}} />
      <RecipeSection typeId={props.typeId} notebook={props.notebook} onOpen={props.onOpen} />
    </div>
  </div>;
}

/** The tag page and Cards tab share the same recipe rows and history. */
export function RecipeSection(props: { typeId: string; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void }) {
  const [version, setVersion] = createSignal(0);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [converting, setConverting] = createSignal(false);
  const [backField, setBackField] = createSignal('');
  const [newField, setNewField] = createSignal('');
  const [backMenu, setBackMenu] = createSignal<HTMLElement | null>(null);
  const doc = createMemo(() => { const value = props.notebook.open(props.typeId); onCleanup(() => value.release()); return value; });
  createEffect(on(() => props.notebook.changeSequence(), () => {
    const timer = setTimeout(() => setVersion(value => value + 1), 150);
    onCleanup(() => clearTimeout(timer));
  }, { defer: true }));
  const [data, { refetch }] = createResource(() => [props.typeId, version()] as const, async ([id]) => {
    const [type, register, templates, cards] = await Promise.all([props.notebook.api.type(id), props.notebook.api.fields(), props.notebook.api.cardTemplates(id), props.notebook.api.cardQuery({ source: typeQuery(id), selection: 'all', limit: 0 })]);
    const members = await props.notebook.api.members(id, Math.max(1, type.members));
    return { type, fields: register.fields, templates, members, cards };
  });
  const fields = createMemo(() => (data.latest?.type.fields ?? []).flatMap(id => data.latest?.fields.find(field => field.id === id && !field.archived) ?? []));
  const atoms = createMemo(() => (data.latest?.members ?? []).flatMap(member => syntaxAtom(member) ?? []));
  const skipped = createMemo(() => (data.latest?.members ?? []).filter(member => !syntaxAtom(member) && (() => { const parsed = parseCardText(member.block.text); return parsed.cards.length || parsed.problems.length; })()));
  const templates = () => data.latest?.templates ?? [];
  const title = () => data.latest?.type.page.text ?? 'Tag';
  const total = () => data.latest?.cards.total ?? 0;
  async function work(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true); setError('');
    try { await action(); await refetch(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function save(previous: CardTemplateInfo | null, value: CardTemplateState | null) {
    await work(async () => {
      const document = doc();
      const result = document.edit({ kind: 'cardTemplate', id: previous?.id ?? ulid(), previous, value });
      if (!result.ok) throw new Error(result.reason);
      await document.flush();
      if (document.saveState() === 'error') throw new Error(document.saveMessage());
    });
  }
  const history = (redo: boolean) => work(async () => { if (redo) doc().redo(); else doc().undo(); await doc().flush(); if (doc().saveState() === 'error') throw new Error(doc().saveMessage()); });
  return <section class="recipe-section ct-sheet" aria-label="Cards" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !(event.target as Element).closest('input, textarea, select, [contenteditable]')) { event.preventDefault(); event.stopPropagation(); void history(event.shiftKey); }
  }}>
    <div class="recipe-section-head"><span class="ct-marker">01</span><h2>Cards</h2><span class="section-rule" /><span>{templates().length} recipes</span><Show when={converting()}><Button onClick={() => setConverting(false)}>Back to recipes</Button></Show></div>
    <Show when={error() || data.error}><p class="error" role="alert">{error() || String(data.error)} <Button onClick={() => void refetch()}>Retry</Button></p></Show>
    <Show when={data.latest} fallback={<p role="status">Loading recipes…</p>}>
      <Show when={converting()} fallback={<>
        <p class="recipe-explanation">Each atom with this tag makes the cards below. Atoms with card syntax keep their existing cards instead.</p>
        <For each={templates().map(template => template.id)}>{id => <Show when={templates().find(template => template.id === id)}>{recipe => <RecipeRow recipe={recipe()} fields={fields()} allFields={data.latest!.fields} busy={busy()} onSave={value => save(recipe(), value)} />}</Show>}</For>
        <div class="ct-bottom-rule"><Button disabled={busy()} onClick={() => void save(null, { type_id: props.typeId, name: `Recipe ${templates().length + 1}`, front: '{@text}', back: fields()[0] ? `{${fields()[0]!.id}}` : '', hint: null, details: [], applied: false, new_per_day: 10 })}>+ Add recipe</Button><span class="ct-inline-rule" /><Button class="ct-apparatus" onClick={event => props.onOpen({ kind: 'review', deckId: props.typeId }, opensBeside(event))}>{total()} cards · #{title()}</Button></div>
        <Show when={atoms().length}><p class="ct-footnote"><Button disabled={busy()} onClick={() => setConverting(true)}>Use fields for these {atoms().length} atoms</Button></p></Show>
      </>}>
        <h3>Use fields for these {atoms().length} atoms</h3><p class="recipe-explanation">Split the existing card text at its operator. Keep each atom where it is, along with its tags, child atoms and review history.</p>
        <div class="recipe-back-field"><span>Back field</span><Button class="ct-chip" aria-label="Back field" aria-haspopup="menu" aria-expanded={!!backMenu()} disabled={busy()} onClick={event => setBackMenu(event.currentTarget)}>{backField() === 'new' ? 'New text field' : fields().find(field => field.id === backField())?.name ?? 'Choose a field'} <Icon name="down" /></Button></div>
        <Show when={backMenu()}>{anchor => <Menu anchor={anchor()} label="Back field" onDismiss={() => setBackMenu(null)} items={[
          ...fields().filter(field => field.kind === 'text').map((field): MenuItem => ({ label: field.name, checked: backField() === field.id, action: () => setBackField(field.id) })),
          { label: 'Create a text field…', divider: fields().some(field => field.kind === 'text'), checked: backField() === 'new', action: () => setBackField('new') },
        ]} />}</Show>
        <Show when={backField() === 'new'}><label class="recipe-back-field">Field name <input class="input" aria-label="Field name" value={newField()} onInput={event => setNewField(event.currentTarget.value)} /></label></Show>
        <Show when={atoms()[0]}>{atom => <div class="ct-template-grid recipe-conversion-example"><div><span class="ct-apparatus">Written now</span><p class="ct-preview-prompt">{atom().source.block.text}</p></div><div class="ct-preview"><span class="ct-apparatus">After conversion</span><p class="ct-preview-prompt">{atom().text}</p><p class="ct-preview-answer">{atom().back}</p></div></div>}</Show>
        <div class="recipe-conversion-counts"><span>{atoms().length} atoms</span><span>{atoms().reduce((sum, atom) => sum + atom.directions.length, 0)} cards kept</span><span>0 new cards</span><span>0 reset</span></div>
        <table class="recipe-conversion-table"><thead><tr><th>Atom text</th><th>{backField() === 'new' ? newField().trim() || 'Back field' : fields().find(field => field.id === backField())?.name ?? 'Back field'}</th><th>Cards</th></tr></thead><tbody><For each={atoms()}>{atom => <tr><td>{atom.text}<Show when={atom.directions.length === 1}><span class="ct-apparatus"> · {atom.directions[0] === 'forward' ? 'Reverse paused' : 'Forward paused'}</span></Show></td><td>{atom.back}</td><td>{atom.directions.length}</td></tr>}</For></tbody></table>
        <Show when={skipped().length}><details><summary>{skipped().length} atoms not converted</summary><For each={skipped()}>{member => <p>{member.block.text}</p>}</For></details></Show>
        <p class="recipe-explanation">Other card syntax keeps working. Atoms still using syntax are not also given these recipe cards; convert them when you choose.</p>
        <div class="ct-apply-footer"><span class="ct-apparatus">One change · Undo restores the written syntax</span><Button disabled={busy()} onClick={() => setConverting(false)}>Not now</Button><Button class="stamp ct-apply" disabled={busy() || !backField() || backField() === 'new' && !newField().trim()} onClick={() => void work(async () => {
          const field = backField() === 'new' ? { name: newField() } : fields().find(field => field.id === backField());
          if (!field) throw new Error('Choose a back field.');
          const pending = convertSyntax(props.notebook, data.latest!.type, atoms(), templates(), field);
          const history = doc().rememberChange(pending);
          await pending; await history;
          setConverting(false);
        })}>Convert {atoms().length} atoms</Button></div>
      </Show>
      <div class="ct-history"><Button disabled={busy() || !doc().canUndo()} onClick={() => void history(false)}>Undo</Button><Button disabled={busy() || !doc().canRedo()} onClick={() => void history(true)}>Redo</Button></div>
    </Show>
  </section>;
}

function RecipeRow(props: { recipe: CardTemplateInfo; fields: readonly FieldDefinition[]; allFields: readonly FieldDefinition[]; busy: boolean; onSave(value: CardTemplateState | null): Promise<void> }) {
  const [patternSide, setPatternSide] = createSignal<'front' | 'back' | null>(null);
  const [pattern, setPattern] = createSignal('');
  const [error, setError] = createSignal('');
  const [menu, setMenu] = createSignal<{ key: 'front' | 'back' | 'hint'; anchor: HTMLElement } | null>(null);
  const single = (key: 'front' | 'back') => props.recipe[key] === '{@text}' || props.fields.some(field => props.recipe[key] === `{${field.id}}`);
  const sideLabel = (key: 'front' | 'back') => props.recipe[key] === '{@text}' ? 'Atom text' : props.fields.find(field => props.recipe[key] === `{${field.id}}`)?.name ?? 'Pattern';
  const editPattern = (key: 'front' | 'back') => { setPatternSide(key); setPattern(displayPattern(props.recipe[key], props.allFields)); };
  const menuItems = (key: 'front' | 'back' | 'hint'): MenuItem[] => key === 'hint'
    ? [{ label: 'None', checked: !props.recipe.hint, action: () => void props.onSave({ ...props.recipe, hint: null }) },
      ...props.fields.map((field): MenuItem => ({ label: field.name, checked: props.recipe.hint === field.id, action: () => void props.onSave({ ...props.recipe, hint: field.id }) }))]
    : [{ label: 'Atom text', checked: props.recipe[key] === '{@text}', action: () => void props.onSave({ ...props.recipe, [key]: '{@text}' }) },
      ...props.fields.map((field): MenuItem => ({ label: field.name, checked: props.recipe[key] === `{${field.id}}`, action: () => void props.onSave({ ...props.recipe, [key]: `{${field.id}}` }) })),
      { label: 'Pattern…', divider: true, checked: !single(key), action: () => editPattern(key) }];
  const side = (label: 'Front' | 'Back', key: 'front' | 'back') => <div class="ct-pattern-line"><span class="ct-pattern-label">{label}</span><Button class="ct-chip" aria-label={`${props.recipe.name} ${label.toLowerCase()}: ${sideLabel(key)}`} aria-haspopup="menu" aria-expanded={menu()?.key === key} disabled={props.busy} onClick={event => setMenu({ key, anchor: event.currentTarget })}>{sideLabel(key)} <Icon name="down" /></Button><Show when={!single(key)}><Button disabled={props.busy} onClick={() => editPattern(key)}>Edit pattern</Button></Show></div>;
  return <article class="ct-section" aria-label={`${props.recipe.name} recipe`}><div class="ct-template-grid"><div>
    <input class="recipe-name" aria-label="Recipe name" value={props.recipe.name} disabled={props.busy} onChange={event => { if (event.currentTarget.value.trim()) void props.onSave({ ...props.recipe, name: event.currentTarget.value }); }} />
    {side('Front', 'front')}{side('Back', 'back')}
    <Show when={patternSide()}>{key => <form class="ct-editor" onSubmit={event => { event.preventDefault(); try { const value = storedPattern(pattern(), props.allFields); void props.onSave({ ...props.recipe, [key()]: value }).then(() => setPatternSide(null)); } catch (reason) { setError(String(reason)); } }}><label>{key() === 'front' ? 'Front' : 'Back'}<input class="input" aria-label="Recipe pattern" value={pattern()} onInput={event => setPattern(event.currentTarget.value)} /></label><p class="ct-footnote">Use {'{@text}'} for atom text or {'{Field name}'} for a field.</p><Button type="submit" disabled={props.busy}>Save pattern</Button><Button onClick={() => setPatternSide(null)}>Cancel</Button></form>}</Show>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
  </div><div class="ct-preview"><Show when={props.recipe.preview} fallback={<p class="ct-apparatus">Waiting for an atom with both sides</p>}>{preview => <><div class="ct-preview-top">Preview · {preview().member_text}</div><p class="ct-preview-prompt">{preview().front}</p><p class="ct-preview-answer">{preview().back}</p></>}</Show></div></div>
    <div class="recipe-enable"><span class="ct-apparatus">{props.recipe.applied ? `${props.recipe.units_active} cards` : 'Not in review'}<Show when={props.recipe.waiting_total}> · {props.recipe.waiting_total} waiting</Show></span><Button disabled={props.busy || !props.recipe.front.trim() || !props.recipe.back.trim()} onClick={() => void props.onSave({ ...props.recipe, applied: !props.recipe.applied })}>{props.recipe.applied ? 'Disable' : 'Enable'}</Button></div>
    <details class="recipe-options"><summary>Details</summary><div class="recipe-back-field"><span>Hint</span><Button class="ct-chip" aria-label={`${props.recipe.name} hint: ${props.fields.find(field => field.id === props.recipe.hint)?.name ?? 'None'}`} aria-haspopup="menu" aria-expanded={menu()?.key === 'hint'} disabled={props.busy} onClick={event => setMenu({ key: 'hint', anchor: event.currentTarget })}>{props.fields.find(field => field.id === props.recipe.hint)?.name ?? 'None'} <Icon name="down" /></Button></div><p class="ct-apparatus">After the answer</p><For each={props.fields.map(field => field.id)}>{id => <label><input type="checkbox" checked={props.recipe.details?.includes(id) ?? false} disabled={props.busy} onChange={event => void props.onSave({ ...props.recipe, details: event.currentTarget.checked ? [...props.recipe.details ?? [], id] : (props.recipe.details ?? []).filter(value => value !== id) })} />{props.fields.find(field => field.id === id)?.name}</label>}</For>
      <For each={props.recipe.details ?? []}>{(id, index) => <div class="recipe-detail-order"><span>{index() + 1} · {props.allFields.find(field => field.id === id)?.name}</span><Button disabled={props.busy || index() === 0} onClick={() => { const details = [...props.recipe.details ?? []]; [details[index() - 1], details[index()]] = [details[index()]!, details[index() - 1]!]; void props.onSave({ ...props.recipe, details }); }}>Move up</Button></div>}</For>
      <div class="ct-schedule"><label>New per day <input class="input ct-rate" type="number" min="1" max="9999" aria-label={`${props.recipe.name} new per day`} value={props.recipe.new_per_day} disabled={props.busy} onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 1 && value <= 9999) void props.onSave({ ...props.recipe, new_per_day: value }); }} /></label><Button disabled={props.busy} onClick={() => void props.onSave(null)}>Delete recipe</Button></div>
    </details>
    <Show when={menu()}>{state => <Menu anchor={state().anchor} label={state().key === 'hint' ? `${props.recipe.name} hint` : `${props.recipe.name} ${state().key}`} onDismiss={() => setMenu(null)} items={menuItems(state().key)} />}</Show>
  </article>;
}
