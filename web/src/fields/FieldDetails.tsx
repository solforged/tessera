import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from 'solid-js';
import type { FieldDetail, FieldKind, FieldOwner, FieldValueUse } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { plainText } from '../outline/names';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { fieldKinds, fieldNameProblem, kindLabels } from './kinds';
import { fieldHide, fieldHides, hideLabels } from './hide';
import type { FieldHide } from './hide';
import './field-page.css';

interface FieldDetailsProps {
  fieldId: string;
  previewKind?: FieldKind;
  section?: 'options' | 'targets';
  inspector?: boolean;
  notebook: NotebookClient;
  document?: PageDocument;
  onPreview(kind?: FieldKind): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onReady?(): void;
}

function ordinal(value: number) {
  const tail = value % 100;
  return `${value}${tail >= 11 && tail <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[value % 10] ?? 'th'}`;
}

function SectionHead(props: { number?: string; title: string; count?: string; problem?: boolean }) {
  return <h2 class="field-section-head"><Show when={props.number}><span class="field-rubric">{props.number}</span></Show><span>{props.title}</span><span class="section-rule" /><Show when={props.count}><span classList={{ 'field-rubric': props.problem }}>{props.count}</span></Show></h2>;
}

/** Both presentations share this request, preview state and section implementation. */
export function FieldDetails(props: FieldDetailsProps) {
  const [result, setResult] = createSignal<FieldDetail>();
  const [error, setError] = createSignal('');
  const [version, setVersion] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [applying, setApplying] = createSignal(false);
  const [menu, setMenu] = createSignal<HTMLElement | null>(null);
  const [hideMenu, setHideMenu] = createSignal<HTMLElement | null>(null);
  const [editing, setEditing] = createSignal<{ id: string; text: string } | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [option, setOption] = createSignal('');
  const [targetsMenu, setTargetsMenu] = createSignal<HTMLElement | null>(null);
  const [targetsDraft, setTargetsDraft] = createSignal<string[]>([]);
  const [types] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.types());
  createEffect(on(() => props.notebook.changeSequence(), () => {
    const timer = setTimeout(() => setVersion(value => value + 1), 150);
    onCleanup(() => clearTimeout(timer));
  }, { defer: true }));
  createEffect(() => {
    const id = props.fieldId; const kind = props.previewKind; version();
    const controller = new AbortController();
    setLoading(true);
    void props.notebook.api.fieldDetail(id, kind, 12, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setResult(value); setError(''); setLoading(false); props.onReady?.();
    }).catch(reason => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    onCleanup(() => controller.abort());
  });
  const data = createMemo(() => {
    const value = result();
    return value?.field.id === props.fieldId && value.kind === (props.previewKind ?? value.field.kind) ? value : undefined;
  });
  const targetTypes = createMemo(() => {
    const pages = new Map((types() ?? []).map(type => [type.page.id, type.page]));
    for (const page of props.notebook.roots()) if (page.kind === 'page' && !page.archived && (['person', 'group'].includes(page.text.toLowerCase()) || data()?.field.targets.includes(page.id))) pages.set(page.id, page);
    return [...pages.values()].sort((a, b) => a.text.localeCompare(b.text));
  });
  let article!: HTMLElement;
  let openedSection = '';
  createEffect(() => {
    const section = props.section;
    if (!data() || !section || openedSection === `${props.fieldId}:${section}`) return;
    openedSection = `${props.fieldId}:${section}`;
    const frame = requestAnimationFrame(() => {
      const target = article.querySelector<HTMLElement>(`[data-field-section="${section}"]`);
      target?.scrollIntoView({ block: 'start' });
      target?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  const preview = () => !!data() && data()!.kind !== data()!.field.kind;
  const ready = () => !loading() && !applying() && props.document?.status() === 'ready' && props.document.saveState() === 'saved';
  const documentError = () => {
    const doc = props.document;
    if (!doc) return '';
    if (doc.status() === 'error' || doc.status() === 'missing') return doc.statusMessage();
    if (['error', 'conflict', 'offline'].includes(doc.saveState())) return doc.saveMessage();
    return '';
  };
  const ownerLink = (owner: FieldOwner, beside: boolean) => props.onOpen({ kind: 'page', pageId: owner.page_id, ...(owner.id !== owner.page_id ? { blockId: owner.id } : {}) }, beside);
  const optionUses = createMemo(() => new Map(data()?.option_uses.map(option => [option.option_id, option.uses])));
  const editText = async () => {
    const edit = editing(); const doc = props.document;
    if (!edit || !doc || !ready()) return;
    const text = edit.text.trim();
    const problem = edit.id === props.fieldId ? fieldNameProblem(text) : !text ? 'An option needs a name.' : null;
    if (problem) { setError(problem); return; }
    setApplying(true);
    try {
      if (edit.id === props.fieldId) {
        const fields = await props.notebook.api.fields();
        const problem = fieldNameProblem(text, fields.fields, edit.id);
        if (problem) { setError(problem); return; }
      }
      const result = doc.edit({ kind: 'text', id: edit.id, text });
      if (!result.ok) { setError(result.reason); return; }
      setEditing(null); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApplying(false); }
  };
  const addOption = () => {
    const doc = props.document; const text = option().trim();
    if (!doc || !ready() || !text) return;
    const result = doc.edit({ kind: 'insert', parentId: props.fieldId, after: doc.outline.children(props.fieldId).at(-1) ?? null, text });
    if (!result.ok) { setError(result.reason); return; }
    setOption(''); setAdding(false); setError('');
  };
  const applyKind = async () => {
    const value = data(); const doc = props.document;
    if (!value || !doc || !ready()) return;
    const result = doc.edit({ kind: 'fieldKind', definition: value.field, value: value.kind });
    if (!result.ok) { setError(result.reason); return; }
    // Keep keyboard history in the pane when Apply is disabled or removed.
    article.focus({ preventScroll: true });
    setApplying(true);
    try { await doc.flush(); if (doc.saveState() === 'saved') props.onPreview(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApplying(false); }
  };
  const applyTargets = async () => {
    const value = data(); const doc = props.document;
    if (!value || !doc || !ready()) return;
    const result = doc.edit({ kind: 'fieldTargets', definition: value.field, targets: targetsDraft() });
    if (!result.ok) { setError(result.reason); return; }
    setTargetsMenu(null); setApplying(true);
    article.focus({ preventScroll: true });
    try { await doc.flush(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApplying(false); }
  };
  const applyHide = async (hide: FieldHide) => {
    const value = data(); const doc = props.document;
    if (!value || !doc || !ready()) return;
    const result = doc.edit({ kind: 'fieldHide', definition: value.field, value: hide });
    if (!result.ok) { setError(result.reason); return; }
    article.focus({ preventScroll: true });
    setApplying(true);
    try { await doc.flush(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApplying(false); }
  };
  const inlineEdit = (id: string) => <Show when={editing()?.id === id}><form class="field-inline-edit" onSubmit={event => { event.preventDefault(); editText(); }}>
    <input class="input" aria-label={id === props.fieldId ? 'Field name' : 'Option name'} value={editing()?.text ?? ''} ref={input => queueMicrotask(() => { input.focus(); input.select(); })} onInput={event => setEditing({ id, text: event.currentTarget.value })} onKeyDown={event => { if (event.key === 'Escape') setEditing(null); }} />
    <Button type="submit" disabled={!ready()}>Save</Button><Button onClick={() => setEditing(null)}>Cancel</Button>
  </form></Show>;
  const ledger = (items: FieldValueUse[], after: boolean) => <table class="field-ledger"><thead><tr><th scope="col">Written value</th><th scope="col">Owner</th><th scope="col">{after ? 'After applying' : 'Problem'}</th></tr></thead><tbody>
    <For each={items}>{item => <tr><td classList={{ 'field-rubric': !item.value.reading.ok }}>{plainText(item.value.text, id => props.notebook.lookup(id))}</td><td><Button onClick={event => ownerLink(item.owner, event.shiftKey)}>{plainText(item.owner.text, id => props.notebook.lookup(id))}</Button></td><td class="field-apparatus">{item.value.reading.ok ? String(item.value.reading.value) : item.value.reading.problem}</td></tr>}</For>
  </tbody></table>;
  const templates = (value: FieldDetail, title: string) => <section class="field-section">
    <SectionHead number={!props.inspector && !preview() ? '02' : undefined} title={title} count={`${value.templates.length} ${value.templates.length === 1 ? 'template' : 'templates'}`} />
    <For each={value.templates} fallback={<p class="field-note">No templates use this field.</p>}>{template => <div class="field-template-row">
      <button type="button" class="outline-tag" onClick={event => props.onOpen({ kind: 'fields', typeId: template.type_id }, event.shiftKey)}>#{template.name}</button>
      <span class="field-apparatus">{ordinal(template.position)} field</span><span class="field-apparatus field-member-count">{template.members} members</span>
      <Show when={!props.inspector}><Button onClick={event => props.onOpen({ kind: 'fields', typeId: template.type_id }, event.shiftKey)}>Open template</Button></Show>
    </div>}</For>
  </section>;
  const dateExample = createMemo(() => {
    const values = data()?.readable ?? [];
    return values.find(item => /^\d{1,3}$/.test(item.value.text.trim())) ?? values[0];
  });
  return <article ref={article} tabIndex={-1} classList={{ 'field-sheet': true, 'field-inspector': props.inspector }} aria-label={props.inspector ? 'Selected definition' : 'Field definition'}>
    <Show when={error()}><p class="error" role="alert">{error()} <Button onClick={() => setVersion(value => value + 1)}>Retry</Button></p></Show>
    <Show when={documentError()}><p class="error" role="alert">{documentError()}</p></Show>
    <Show when={data()} fallback={<Show when={loading()}><p role="status">Loading field…</p></Show>}>{value => <>
      <div class="field-eyebrow"><Show when={props.inspector} fallback={<><Button onClick={event => props.onOpen({ kind: 'fields' }, event.shiftKey)}>Fields</Button> / Definition</>}>Selected definition</Show></div>
      <header class="field-heading"><h1>{value().field.name}</h1><Show when={props.inspector} fallback={<Show when={!preview()}><Button disabled={!ready()} onClick={() => setEditing({ id: props.fieldId, text: value().field.name })}>Rename…</Button></Show>}><Button onClick={event => props.onOpen({ kind: 'field', fieldId: props.fieldId }, event.shiftKey)}>Open page ↗</Button></Show></header>
      {inlineEdit(props.fieldId)}
      <p class="field-summary">{kindLabels[value().field.kind]} · {value().owners_total} owners · {value().values_total} values</p>
      <div class="field-kind-row"><span>{preview() ? 'Change kind' : 'Kind'}</span><Show when={preview()}><span class="field-apparatus">{kindLabels[value().field.kind]} →</span></Show><Button class="bordered" aria-label={`Kind for ${value().field.name}: ${kindLabels[value().kind]}`} aria-haspopup="menu" aria-expanded={!!menu()} disabled={applying()} onClick={event => setMenu(event.currentTarget)}>{kindLabels[value().kind]} <Icon name="down" /></Button></div>
      <Show when={value().kind === 'instance' && !preview()}><div class="field-kind-row" data-field-section="targets"><span>Links to</span><Button class="bordered" disabled={!ready()} aria-haspopup="dialog" aria-expanded={!!targetsMenu()} onClick={event => { setTargetsDraft([...value().field.targets]); setTargetsMenu(event.currentTarget); }}>{value().field.targets.map(id => props.notebook.lookup(id)()?.text ?? id).join(', ') || 'Any page'} <Icon name="down" /></Button></div></Show>
      <div class="field-kind-row"><span>Hide</span><Button class="bordered" aria-label={`Hide for ${value().field.name}: ${hideLabels[fieldHide(value().field)]}`} aria-haspopup="menu" aria-expanded={!!hideMenu()} disabled={!ready()} onClick={event => setHideMenu(event.currentTarget)}>{hideLabels[fieldHide(value().field)]} <Icon name="down" /></Button></div>
      <p class="field-note">{fieldHide(value().field) === 'never' ? 'Shown even when empty.' : fieldHide(value().field) === 'when_empty' ? 'Hidden in notes while empty.' : 'Hidden in notes; tables still show it.'}</p>
      <Show when={preview()} fallback={<>
        <Show when={value().kind === 'choice' && !props.inspector}><section class="field-section" data-field-section="options"><SectionHead number="01" title="Options" count={`${value().field.options.length} options`} />
          <table class="field-ledger field-options"><thead><tr><th scope="col">Value</th><th scope="col">Uses</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody><For each={value().field.options}>{option => <tr><td><Show when={editing()?.id !== option.id} fallback={inlineEdit(option.id)}>{option.text}</Show></td><td class="field-apparatus">{optionUses().get(option.id) ?? 0}</td><td><Button disabled={!ready()} aria-label={`Rename option ${option.text}`} onClick={() => setEditing({ id: option.id, text: option.text })}>Edit…</Button></td></tr>}</For></tbody></table>
          <Show when={adding()} fallback={<Button class="field-add" disabled={!ready()} onClick={() => setAdding(true)}>+ Add option</Button>}><form class="field-inline-edit" onSubmit={event => { event.preventDefault(); addOption(); }}><input class="input" aria-label="New option" value={option()} onInput={event => setOption(event.currentTarget.value)} ref={input => queueMicrotask(() => input.focus())} /><Button type="submit" disabled={!ready() || !option().trim()}>Add option</Button><Button onClick={() => setAdding(false)}>Cancel</Button></form></Show>
        </section></Show>
        <Show when={!props.inspector}>{templates(value(), 'In templates')}</Show>
        <Show when={props.inspector && value().kind === 'date'}><section class="field-section"><SectionHead title="Reading" /><Show when={dateExample()} fallback={<p class="field-note">Accepts bare years from 1 to 9999. No day is added.</p>}>{example => <p class="field-apparatus">{plainText(example().value.text, id => props.notebook.lookup(id))} → {(() => { const reading = example().value.reading; if (!reading.ok) return ''; const text = String(reading.value); return /^\d{1,4}$/.test(text) ? `year ${Number(text)}` : text; })()}</p>}</Show></section></Show>
        <section class="field-section"><SectionHead number={props.inspector ? undefined : '03'} title="Used by" count={`${value().owners_total} owners`} /><div class="field-owners"><For each={value().owners} fallback={<p class="field-note">No owners yet.</p>}>{item => <div class="field-owner"><Button onClick={event => ownerLink(item.owner, event.shiftKey)}>{plainText(item.owner.text, id => props.notebook.lookup(id))}</Button><div class="field-owner-values"><For each={item.values} fallback={<span class="field-apparatus">Empty</span>}>{fieldValue => <span classList={{ 'field-apparatus': true, 'field-rubric': !fieldValue.reading.ok }}>{fieldValue.reading.ok ? String(fieldValue.reading.value) : plainText(fieldValue.text, id => props.notebook.lookup(id))}</span>}</For></div></div>}</For></div>
          <Show when={value().owners_total}><Button class="field-view-all" onClick={event => props.onOpen({ kind: 'table', typeId: null, viewId: null, query: { type: null, text: null, filters: [{ field: props.fieldId, op: 'present', value: null }], sort: [], limit: null } }, event.shiftKey)}>View all {value().owners_total} owners →</Button></Show>
        </section>
        <Show when={props.inspector}>{templates(value(), 'In templates')}</Show>
        <Show when={!props.inspector}><section class="field-section"><SectionHead number="04" title="Problem values" count={`${value().problems_total} ${value().problems_total === 1 ? 'value' : 'values'}`} problem={!!value().problems_total} /><Show when={value().problems_total} fallback={<p class="field-note">No problem values.</p>}>{ledger(value().problems, false)}<Show when={value().problems_total > value().problems.length}><p class="field-apparatus">Showing the first {value().problems.length} problems.</p></Show><p class="field-note">The value stays as written. Open its owner to edit it{value().kind === 'choice' ? ', or add it to the options.' : '.'}</p></Show></section></Show>
      </>}>
        <section class="field-preview-summary"><h2><Show when={value().problems_total} fallback={<span>All {value().values_total} values will read as {kindLabels[value().kind]}.</span>}><span class="field-rubric">{value().problems_total} of {value().values_total}</span>{` values won't read as ${kindLabels[value().kind]}`}</Show></h2><Show when={!props.inspector}><p class="field-note">Value text is never rewritten. Owners and child notes stay in place.</p></Show></section>
        <Show when={!props.inspector} fallback={<div class="field-preview-actions"><Button onClick={() => props.onPreview()}>Cancel</Button><Button onClick={event => props.onOpen({ kind: 'field', fieldId: props.fieldId, previewKind: value().kind }, event.shiftKey)}>Open preview</Button></div>}>
          <Show when={value().problems_total}><section class="field-section"><SectionHead title="Will become problems" count={`${value().problems_total} values`} />{ledger(value().problems, true)}<Show when={value().problems_total > value().problems.length}><p class="field-apparatus">Showing the first {value().problems.length} problems.</p></Show></section></Show>
          <section class="field-section"><SectionHead title={`Will read as ${kindLabels[value().kind]}`} count={`${value().values_total - value().problems_total} values`} />{ledger(value().readable, true)}<Show when={value().values_total - value().problems_total > value().readable.length}><p class="field-apparatus">Showing the first {value().readable.length} readable values.</p></Show></section>
          {templates(value(), 'Also used in')}
          <footer class="field-preview-actions"><span class="field-apparatus">One undoable change · text preserved</span><Button disabled={applying()} onClick={() => props.onPreview()}>Cancel</Button><Button class="bordered" disabled={!ready()} onClick={() => void applyKind()}>Apply kind change</Button></footer>
        </Show>
      </Show>
      <Show when={menu()}>{anchor => <Menu anchor={anchor()} label={`Kind for ${value().field.name}`} onDismiss={() => setMenu(null)} items={fieldKinds.map(kind => ({ label: kindLabels[kind], icon: kind === value().kind ? 'check' : undefined, action: () => { setEditing(null); props.onPreview(kind === value().field.kind ? undefined : kind); } }))} />}</Show>
      <Show when={hideMenu()}>{anchor => <Menu anchor={anchor()} label={`Hide for ${value().field.name}`} onDismiss={() => setHideMenu(null)} items={fieldHides.map(hide => ({ label: hideLabels[hide], checked: hide === fieldHide(value().field), action: () => { void applyHide(hide); } }))} />}</Show>
      <Show when={targetsMenu()}>{anchor => <Popup anchor={anchor()} label="Links to" onDismiss={() => setTargetsMenu(null)}>
        <h2 class="popup-title">Links to</h2><p class="field-note">No selection means Any page.</p>
        <Show when={types.error}><p class="error" role="alert">Could not load types.</p></Show>
        <For each={targetTypes()}>{type => <label class="menu-item"><input type="checkbox" checked={targetsDraft().includes(type.id)} onChange={event => setTargetsDraft(previous => event.currentTarget.checked ? [...previous, type.id] : previous.filter(id => id !== type.id))} />{type.text}</label>}</For>
        <div class="popup-actions"><Button onClick={() => setTargetsMenu(null)}>Cancel</Button><Button class="bordered" disabled={!ready()} onClick={() => void applyTargets()}>Apply</Button></div>
      </Popup>}</Show>
    </>}</Show>
  </article>;
}
