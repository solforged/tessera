import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from 'solid-js';
import type { FieldDetail, FieldKind, FieldOwner, FieldValueUse } from '../api/types';
import type { DocumentChange, NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { opensBeside } from '../shell/beside';
import { plainText } from '../outline/names';
import { plural } from '../sync/state';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { fieldKinds, fieldNameProblem, kindLabels } from './kinds';
import { fieldHide, fieldHides, hideLabels } from './hide';
import type { FieldHide } from './hide';
import { fieldRole, fieldRoles, roleDescriptions, roleLabels } from './roles';
import type { FieldRole } from './roles';
import './field-page.css';
import { ChoiceConversion, readingLabel } from './ChoiceConversion';
import { changeFieldKind, choicePreview, makeFieldOption, fieldImpact, applyFieldImpact } from './commands';
import type { InterpretationMap, FieldImpact } from './commands';
import { FieldImpactPreview } from './FieldImpactPreview';

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
  const [roleMenu, setRoleMenu] = createSignal<HTMLElement | null>(null);
  const [editing, setEditing] = createSignal<{ id: string; text: string } | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [option, setOption] = createSignal('');
  const [targetsMenu, setTargetsMenu] = createSignal<HTMLElement | null>(null);
  const [targetsDraft, setTargetsDraft] = createSignal<string[]>([]);
  const [mappings, setMappings] = createSignal<InterpretationMap>({});
  const [impact, setImpact] = createSignal<FieldImpact>();
  const [register] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.fields());
  const [lastChange, setLastChange] = createSignal<DocumentChange>();
  const [removed, setRemoved] = createSignal(false);
  createEffect(on(() => props.fieldId, () => setRemoved(false)));
  const previewKey = createMemo(() => `${props.fieldId}:${props.previewKind ?? ''}`);
  createEffect(on(previewKey, () => { setMappings({}); setImpact(undefined); }));
  const [types] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.types());
  createEffect(on(() => props.notebook.changeSequence(), () => {
    const timer = setTimeout(() => setVersion(value => value + 1), 150);
    onCleanup(() => clearTimeout(timer));
  }, { defer: true }));
  createEffect(on([previewKey, version, removed], () => {
    const id = props.fieldId; const kind = props.previewKind;
    if (removed()) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    void props.notebook.api.fieldDetail(id, kind, 12, controller.signal).then(async value => {
      const mappings: InterpretationMap = {};
      if (kind === 'choice') for (const row of value.interpretations) {
        if (!row.reading.ok) mappings[row.text] = { mode: 'option', value: value.choice_candidates.find(candidate => candidate.values.some(item => item.id === row.values[0]?.id))?.text ?? row.text.trim() };
      }
      if (kind === 'instance') await Promise.all(value.interpretations.filter(row => !row.reading.ok).map(async row => {
        const matches = await props.notebook.api.resolveName(row.text, controller.signal);
        if (matches.length === 1) mappings[row.text] = { mode: 'page', value: matches[0]!.page.id };
      }));
      if (controller.signal.aborted) return;
      setMappings(mappings); setResult(value); setError(''); setLoading(false); props.onReady?.();
    }).catch(reason => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    onCleanup(() => controller.abort());
  }));
  const rawData = createMemo(() => {
    const value = result();
    return !removed() && value?.field.id === props.fieldId && value.kind === (props.previewKind ?? value.field.kind) ? value : undefined;
  });
  const data = createMemo(() => {
    const detail = rawData();
    return detail && props.previewKind ? choicePreview(detail, mappings()) : detail;
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
        const existing = fields.fields.find(field => field.id !== edit.id && field.name.trim().toLocaleLowerCase() === text.toLocaleLowerCase());
        if (existing) { setImpact(await fieldImpact(props.notebook, edit.id, existing.id)); setEditing(null); setError(''); return; }
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
    const value = rawData(); const doc = props.document;
    if (!value || !doc || !ready()) return;
    const convertValues = mappings();
    article.focus({ preventScroll: true });
    setApplying(true);
    try {
      setLastChange(doc.rememberChange(await changeFieldKind(props.notebook, value, convertValues)));
      props.onPreview();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApplying(false); }
  };
  const makeOption = async (text: string) => {
    const value = rawData(); const doc = props.document;
    if (!value || !doc || !ready()) return;
    setApplying(true);
    try { setLastChange(doc.rememberChange(await makeFieldOption(props.notebook, value, text))); setVersion(value => value + 1); }
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
  const applyRole = async (role: FieldRole) => {
    const value = data(); const doc = props.document;
    if (!value || !doc || !ready()) return;
    const result = doc.edit({ kind: 'fieldRole', definition: value.field, value: role });
    if (!result.ok) { setError(result.reason); return; }
    setRoleMenu(null); article.focus({ preventScroll: true }); setApplying(true);
    try { await doc.flush(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApplying(false); }
  };
  const previewImpact = async (target?: string) => {
    setApplying(true);
    try { await props.document?.flush(); setImpact(await fieldImpact(props.notebook, props.fieldId, target)); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApplying(false); }
  };
  const applyImpact = async (action: 'archive' | 'merge' | 'detach' | 'delete') => {
    const current = impact(); const doc = props.document;
    if (!current || !doc || !ready()) return;
    setApplying(true);
    try {
      setLastChange(doc.rememberChange(await applyFieldImpact(props.notebook, current, action)));
      setRemoved(action !== 'archive'); setImpact(undefined); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApplying(false); }
  };
  const inlineEdit = (id: string) => <Show when={editing()?.id === id}><form class="field-inline-edit" onSubmit={event => { event.preventDefault(); editText(); }}>
    <input class="input" aria-label={id === props.fieldId ? 'Field name' : 'Option name'} value={editing()?.text ?? ''} ref={input => queueMicrotask(() => { input.focus(); input.select(); })} onInput={event => setEditing({ id, text: event.currentTarget.value })} onKeyDown={event => { if (event.key === 'Escape') setEditing(null); }} />
    <Button type="submit" disabled={!ready()}>Save</Button><Button onClick={() => setEditing(null)}>Cancel</Button>
  </form></Show>;
  const ledger = (items: FieldValueUse[], after: boolean) => <table class="field-ledger"><thead><tr><th scope="col">Written value</th><th scope="col">Owner</th><th scope="col">{after ? 'After applying' : 'Problem'}</th></tr></thead><tbody>
    <For each={items}>{item => <tr><td classList={{ 'field-rubric': !item.value.reading.ok }}>{plainText(item.value.text, id => props.notebook.lookup(id))}</td><td><Button onClick={event => ownerLink(item.owner, opensBeside(event))}>{plainText(item.owner.text, id => props.notebook.lookup(id))}</Button></td><td class="field-apparatus">{readingLabel(item.value.reading)}<Show when={!after && data()?.kind === 'choice'}><Button disabled={!ready()} onClick={() => void makeOption(item.value.text)}>Make option</Button></Show></td></tr>}</For>
  </tbody></table>;
  const templates = (value: FieldDetail, title: string) => <section class="field-section">
    <SectionHead number={!props.inspector && !preview() ? value.kind === 'choice' ? '02' : '01' : undefined} title={title} count={plural(value.templates.length, 'template')} />
    <For each={value.templates} fallback={<p class="field-note">No templates use this field.</p>}>{template => <div class="field-template-row">
      <button type="button" class="outline-tag" onClick={event => props.onOpen({ kind: 'fields', typeId: template.type_id }, opensBeside(event))}>#{template.name}</button>
      <span class="field-apparatus">{ordinal(template.position)} field</span><span class="field-apparatus field-member-count">{plural(template.members, 'member')}</span>
      <Show when={!props.inspector}><Button onClick={event => props.onOpen({ kind: 'fields', typeId: template.type_id }, opensBeside(event))}>Open template</Button></Show>
    </div>}</For>
  </section>;
  const dateExample = createMemo(() => {
    const values = data()?.readable ?? [];
    return values.find(item => /^\d{1,3}$/.test(item.value.text.trim())) ?? values[0];
  });
  return <article ref={article} tabIndex={-1} classList={{ 'field-sheet': true, 'field-inspector': props.inspector }} aria-label={props.inspector ? 'Selected definition' : 'Field definition'}>
    <Show when={error()}><p class="error" role="alert">{error()} <Button onClick={() => setVersion(value => value + 1)}>Retry</Button></p></Show>
    <Show when={documentError()}><p class="error" role="alert">{documentError()}</p></Show>
    <Show when={lastChange()}>{change => <p class="field-note">Field changed. <Button disabled={applying()} onClick={async () => { setApplying(true); try { await change().undo(); setRemoved(false); setLastChange(undefined); setVersion(value => value + 1); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setApplying(false); } }}>Undo</Button></p>}</Show>
    <Show when={data()} fallback={<Show when={loading()}><p role="status">Loading field…</p></Show>}>{value => <>
      <div class="field-eyebrow"><Show when={props.inspector} fallback={<><Button onClick={event => props.onOpen({ kind: 'fields' }, opensBeside(event))}>Fields</Button> / Definition</>}>Selected definition</Show></div>
      <header class="field-heading"><h1>{value().field.name}</h1><Show when={props.inspector} fallback={<Show when={!preview()}><Button disabled={!ready() || value().field.built_in} title={value().field.built_in ? `${value().field.name} is built in and cannot be renamed.` : undefined} onClick={() => setEditing({ id: props.fieldId, text: value().field.name })}>Rename…</Button></Show>}><Button onClick={event => props.onOpen({ kind: 'field', fieldId: props.fieldId }, opensBeside(event))}>Open page ↗</Button></Show></header>
      {inlineEdit(props.fieldId)}
      <Show when={!preview() && !props.inspector}><Button disabled={!ready()} onClick={() => void previewImpact()}>Delete definition…</Button></Show>
      <Show when={value().field.archived}><p class="field-note">Archived; values remain readable.</p></Show>
      <Show when={impact()}>{current => <FieldImpactPreview impact={current()} fields={register()?.fields ?? []} busy={applying()} onTarget={target => void previewImpact(target)} onApply={action => void applyImpact(action)} onCancel={() => setImpact(undefined)} />}</Show>
      <p class="field-summary">{kindLabels[value().field.kind]} · {plural(value().owners_total, 'owner')} · {plural(value().values_total, 'value')}</p>
      <div class="field-kind-row"><span>{preview() ? 'Change kind' : 'Kind'}</span><Show when={preview()}><span class="field-apparatus">{kindLabels[value().field.kind]} →</span></Show><Button class="bordered" aria-label={`Kind for ${value().field.name}: ${kindLabels[value().kind]}`} aria-haspopup="menu" aria-expanded={!!menu()} disabled={applying()} onClick={event => setMenu(event.currentTarget)}>{kindLabels[value().kind]} <Icon name="down" /></Button></div>
      <Show when={value().kind === 'instance' && !preview()}><div class="field-kind-row" data-field-section="targets"><span>Links to</span><Button class="bordered" disabled={!ready()} aria-haspopup="dialog" aria-expanded={!!targetsMenu()} onClick={event => { setTargetsDraft([...value().field.targets]); setTargetsMenu(event.currentTarget); }}>{value().field.targets.map(id => props.notebook.lookup(id)()?.text ?? id).join(', ') || 'Any block'} <Icon name="down" /></Button></div></Show>
      <div class="field-kind-row"><span>Hide</span><Button class="bordered" aria-label={`Hide for ${value().field.name}: ${hideLabels[fieldHide(value().field)]}`} aria-haspopup="menu" aria-expanded={!!hideMenu()} disabled={!ready()} onClick={event => setHideMenu(event.currentTarget)}>{hideLabels[fieldHide(value().field)]} <Icon name="down" /></Button></div>
      <p class="field-note">{fieldHide(value().field) === 'never' ? 'Shown even when empty.' : fieldHide(value().field) === 'when_empty' ? 'Hidden in notes while empty.' : 'Hidden in notes; tables still show it.'}</p>
      <div class="field-kind-row"><span>Role</span><Button class="bordered" aria-label={`Role for ${value().field.name}: ${roleLabels[fieldRole(value().field)]}`} aria-haspopup="menu" aria-expanded={!!roleMenu()} disabled={!ready()} onClick={event => setRoleMenu(event.currentTarget)}>{roleLabels[fieldRole(value().field)]} <Icon name="down" /></Button></div>
      <p class="field-note">{roleDescriptions[fieldRole(value().field)]}</p>
      <Show when={preview()} fallback={<>
        <Show when={value().kind === 'choice' && !props.inspector}><section class="field-section" data-field-section="options"><SectionHead number="01" title="Options" count={plural(value().field.options.length, 'option')} />
          <table class="field-ledger field-options"><thead><tr><th scope="col">Value</th><th scope="col">Uses</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody><For each={value().field.options}>{option => <tr><td><Show when={editing()?.id !== option.id} fallback={inlineEdit(option.id)}>{option.text}</Show></td><td class="field-apparatus">{optionUses().get(option.id) ?? 0}</td><td><Button disabled={!ready()} aria-label={`Rename option ${option.text}`} onClick={() => setEditing({ id: option.id, text: option.text })}>Edit…</Button></td></tr>}</For></tbody></table>
          <Show when={adding()} fallback={<Button class="field-add" disabled={!ready()} onClick={() => setAdding(true)}>+ Add option</Button>}><form class="field-inline-edit" onSubmit={event => { event.preventDefault(); addOption(); }}><input class="input" aria-label="New option" value={option()} onInput={event => setOption(event.currentTarget.value)} ref={input => queueMicrotask(() => input.focus())} /><Button type="submit" disabled={!ready() || !option().trim()}>Add option</Button><Button onClick={() => setAdding(false)}>Cancel</Button></form></Show>
        </section></Show>
        <Show when={!props.inspector}>{templates(value(), 'In templates')}</Show>
        <Show when={props.inspector && value().kind === 'date'}><section class="field-section"><SectionHead title="Reading" /><Show when={dateExample()} fallback={<p class="field-note">Accepts bare years from 1 to 9999. No day is added.</p>}>{example => <p class="field-apparatus">{plainText(example().value.text, id => props.notebook.lookup(id))} → {(() => { const reading = example().value.reading; if (!reading.ok) return ''; const text = String(reading.value); return /^\d{1,4}$/.test(text) ? `year ${Number(text)}` : text; })()}</p>}</Show></section></Show>
        <section class="field-section"><SectionHead number={props.inspector ? undefined : value().kind === 'choice' ? '03' : '02'} title="Used by" count={plural(value().owners_total, 'owner')} /><div class="field-owners"><For each={value().owners} fallback={<p class="field-note">No owners yet.</p>}>{item => <div class="field-owner"><Button onClick={event => ownerLink(item.owner, opensBeside(event))}>{plainText(item.owner.text, id => props.notebook.lookup(id))}</Button><div class="field-owner-values"><For each={item.values} fallback={<span class="field-apparatus">Empty</span>}>{fieldValue => <span classList={{ 'field-apparatus': true, 'field-rubric': !fieldValue.reading.ok }}>{fieldValue.reading.ok && typeof fieldValue.reading.value !== 'object' ? readingLabel(fieldValue.reading) : plainText(fieldValue.text, id => props.notebook.lookup(id))}</span>}</For></div></div>}</For></div>
          <Show when={value().owners_total}><Button class="field-view-all" onClick={event => props.onOpen({ kind: 'table', typeId: null, viewId: null, query: { type: null, text: null, filters: [{ field: props.fieldId, op: 'present', value: null }], sort: [], limit: null } }, opensBeside(event))}>{value().owners_total === 1 ? 'View owner' : `View all ${plural(value().owners_total, 'owner')}`} →</Button></Show>
        </section>
        <Show when={props.inspector}>{templates(value(), 'In templates')}</Show>
        <Show when={!props.inspector}><section class="field-section"><SectionHead number={value().kind === 'choice' ? '04' : '03'} title="Problem values" count={plural(value().problems_total, 'value')} problem={!!value().problems_total} /><Show when={value().problems_total} fallback={<p class="field-note">No problem values.</p>}>{ledger(value().problems, false)}<Show when={value().problems_total > value().problems.length}><p class="field-apparatus">Showing the first {plural(value().problems.length, 'problem')}.</p></Show><p class="field-note">{value().kind === 'choice' ? 'Make it an option, or open its owner to edit it.' : 'The value stays as written. Open its owner to edit it.'}</p></Show></section></Show>
      </>}>
        <Show when={!props.inspector}><ChoiceConversion detail={rawData()!} mappings={mappings()} notebook={props.notebook} disabled={applying()} onChange={setMappings} /></Show>
        <section class="field-preview-summary" classList={{ 'field-preview-clean': !value().problems_total }}><h2>{value().problems_total ? `${value().problems_total} of ${plural(value().values_total, 'value')} would stay unreadable` : `All ${plural(value().values_total, 'value')} read as ${kindLabels[value().kind]}`}</h2><p class="field-note">Owners and child notes stay in place.</p></section>
        <Show when={!props.inspector} fallback={<div class="field-preview-actions"><Button onClick={() => props.onPreview()}>Cancel</Button><Button onClick={event => props.onOpen({ kind: 'field', fieldId: props.fieldId, previewKind: value().kind }, opensBeside(event))}>Open preview</Button></div>}>
          <Show when={value().problems_total}><section class="field-section"><SectionHead title="Will become problems" count={plural(value().problems_total, 'value')} />{ledger(value().problems, true)}<Show when={value().problems_total > value().problems.length}><p class="field-apparatus">Showing the first {plural(value().problems.length, 'problem')}.</p></Show></section></Show>
          <section class="field-section"><SectionHead title={`Will read as ${kindLabels[value().kind]}`} count={plural(value().values_total - value().problems_total, 'value')} />{ledger(value().readable, true)}<Show when={value().values_total - value().problems_total > value().readable.length}><p class="field-apparatus">Showing the first {plural(value().readable.length, 'readable value')}.</p></Show></section>
          {templates(value(), 'Also used in')}
          <footer class="field-preview-actions"><span class="field-apparatus">One undoable change</span><Button disabled={applying()} onClick={() => props.onPreview()}>Cancel</Button><Button class="bordered" disabled={!ready()} onClick={() => void applyKind()}>Apply kind change</Button></footer>
        </Show>
      </Show>
      <Show when={menu()}>{anchor => <Menu anchor={anchor()} label={`Kind for ${value().field.name}`} onDismiss={() => setMenu(null)} items={fieldKinds.map(kind => ({ label: kindLabels[kind], icon: kind === value().kind ? 'check' : undefined, action: () => { setEditing(null); props.onPreview(kind === value().field.kind ? undefined : kind); } }))} />}</Show>
      <Show when={hideMenu()}>{anchor => <Menu anchor={anchor()} label={`Hide for ${value().field.name}`} onDismiss={() => setHideMenu(null)} items={fieldHides.map(hide => ({ label: hideLabels[hide], checked: hide === fieldHide(value().field), action: () => { void applyHide(hide); } }))} />}</Show>
      <Show when={roleMenu()}>{anchor => <Menu anchor={anchor()} label={`Role for ${value().field.name}`} onDismiss={() => setRoleMenu(null)} items={fieldRoles.map(role => ({ label: roleLabels[role], checked: role === fieldRole(value().field), action: () => { void applyRole(role); } }))} />}</Show>
      <Show when={targetsMenu()}>{anchor => <Popup anchor={anchor()} label="Links to" onDismiss={() => setTargetsMenu(null)}>
        <h2 class="popup-title">Links to</h2><p class="field-note">No selection means Any block.</p>
        <Show when={types.error}><p class="error" role="alert">Could not load types.</p></Show>
        <For each={targetTypes()}>{type => <label class="menu-item"><input type="checkbox" checked={targetsDraft().includes(type.id)} onChange={event => setTargetsDraft(previous => event.currentTarget.checked ? [...previous, type.id] : previous.filter(id => id !== type.id))} />{type.text}</label>}</For>
        <div class="popup-actions"><Button onClick={() => setTargetsMenu(null)}>Cancel</Button><Button class="bordered" disabled={!ready()} onClick={() => void applyTargets()}>Apply</Button></div>
      </Popup>}</Show>
    </>}</Show>
  </article>;
}
