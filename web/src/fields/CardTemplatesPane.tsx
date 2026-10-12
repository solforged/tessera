import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from 'solid-js';
import { ulid } from 'ulid';
import type { CardTemplateInfo, CardTemplateState, FieldDefinition } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { FieldsViewState, OpenTarget } from '../shell/contract';
import { typeQuery } from '../table/query';
import { Button } from '../ui/Button';
import { TypeModeTabs } from '../ui/TypeModeTabs';
import { FieldPicker } from './FieldPicker';
import { displayPattern, patternParts, storedPattern, usedFields } from './card-patterns';
import { isStableReference, textTokens } from '../document/text-tokens';
import { referenceLabel } from '../outline/BlockText';
import './card-templates.css';

interface Props {
  typeId: string; applyId?: string; notebook: NotebookClient; view: FieldsViewState;
  onActivate(): void; onOpen(target: OpenTarget, beside: boolean): void; onViewChange(view: FieldsViewState): void;
}

export function CardTemplatesPane(props: Props) {
  const [version, setVersion] = createSignal(0);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [shown, setShown] = createSignal(20);
  const doc = createMemo(() => {
    const value = props.notebook.open(props.typeId);
    onCleanup(() => value.release());
    return value;
  });
  let scroll!: HTMLDivElement;
  let restored = false;
  createEffect(on(() => props.notebook.changeSequence(), () => {
    const timer = setTimeout(() => setVersion(value => value + 1), 150);
    onCleanup(() => clearTimeout(timer));
  }, { defer: true }));
  const [data, { refetch }] = createResource(() => [props.typeId, version()] as const, async ([id]) => {
    const [type, fields, templates, index] = await Promise.all([
      props.notebook.api.type(id), props.notebook.api.fields(), props.notebook.api.cardTemplates(id), props.notebook.api.noteIndex(),
    ]);
    return { type, fields: fields.fields, templates, kind: index.kinds.find(kind => kind.type_id === id) };
  });
  const title = () => data.latest?.type.page.text ?? props.notebook.lookup(props.typeId)()?.text ?? 'Type';
  const templates = () => data.latest?.templates ?? [];
  const templatesById = createMemo(() => new Map(templates().map(template => [template.id, template])));
  const applyTemplate = () => props.applyId ? templatesById().get(props.applyId) : undefined;
  const [forecast, { refetch: refetchForecast }] = createResource(() => props.applyId ? [props.applyId, version()] as const : false,
    ([id]) => props.notebook.api.cardTemplateForecast(id));
  const first = () => templates()[0];
  const fields = createMemo(() => {
    const byId = new Map(data.latest?.fields.map(field => [field.id, field]));
    return (data.latest?.type.fields ?? []).flatMap(id => byId.get(id) ?? []);
  });
  const total = () => templates().reduce((sum, template) => sum + template.ready, 0);
  createEffect(() => {
    if (!data.latest || restored) return;
    restored = true;
    requestAnimationFrame(() => { scroll.scrollTop = props.view.scroll; });
  });
  onMount(() => { requestAnimationFrame(() => scroll.focus({ preventScroll: true })); });

  async function save(template: CardTemplateInfo | null, value: CardTemplateState | null, id = template?.id ?? ulid()) {
    if (busy()) return;
    setBusy(true); setError('');
    try {
      const document = doc();
      const result = document.edit({ kind: 'cardTemplate', id, previous: template, value });
      if (!result.ok) throw new Error(result.reason);
      await document.flush();
      if (document.saveState() === 'error') throw new Error(document.saveMessage());
      await refetch();
      if (props.applyId) await refetchForecast();
      setEditing(null);
      return id;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally { setBusy(false); }
  }
  async function history(redo: boolean) {
    if (busy()) return;
    setBusy(true); setError('');
    try {
      if (redo) doc().redo(); else doc().undo();
      await doc().flush();
      if (doc().saveState() === 'error') throw new Error(doc().saveMessage());
      await refetch();
      if (props.applyId) await refetchForecast();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const toCards = () => props.onOpen({ kind: 'cards', typeId: props.typeId }, false);
  return <div ref={scroll} class="card-templates-pane" role="region" aria-label={`${title()} cards`} tabIndex={0} onFocusIn={props.onActivate}
    onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })} onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !(event.target as Element).closest('input, textarea, [contenteditable]')) {
        event.preventDefault(); event.stopPropagation(); void history(event.shiftKey);
      }
    }}>
    <div class="ct-sheet">
      <header class="ct-heading">
        <div class="ct-apparatus ct-crumb"><Button onClick={event => props.onOpen({ kind: 'page', pageId: props.typeId }, event.shiftKey)}>{title()}</Button><span> / {props.applyId ? `${applyTemplate()?.name ?? 'Cards'} / Apply` : 'Card templates'}</span></div>
        <div class="ct-title-row"><h1>{title()}</h1><span class="ct-apparatus">{templates().length} {templates().length === 1 ? 'template' : 'templates'} · {templates().filter(template => template.applied).length} enabled</span></div>
      </header>
      <TypeModeTabs active="cards" indexCount={data.latest?.kind?.count ?? 0} tableCount={data.latest?.type.members ?? 0} fieldsCount={fields().length} cardsCount={templates().length}
        onIndex={event => props.onOpen({ kind: 'index', key: data.latest?.kind?.key ?? `type:${props.typeId}` }, event.shiftKey)}
        onTable={event => props.onOpen({ kind: 'table', typeId: props.typeId, viewId: null, query: typeQuery(props.typeId) }, event.shiftKey)}
        onFields={event => props.onOpen({ kind: 'fields', typeId: props.typeId }, event.shiftKey)} onCards={toCards} />
      <Show when={error() || data.error || forecast.error}><p role="alert" class="error">{error() || String(data.error || forecast.error)} <Button onClick={() => { setError(''); setVersion(value => value + 1); }}>Retry</Button></p></Show>
      <Show when={data.latest} fallback={<p class="empty-state" role="status">Loading templates…</p>}>
        <Show when={props.applyId} fallback={<>
          <div class="ct-meta"><span><span class="ct-num">{data.latest?.type.members ?? 0}</span> members</span><Show when={first()}>{template => <><span>{template().ready} ready</span><Show when={template().waiting_total > 0}><span class="ct-wait">{template().waiting_total} waiting{template().missing[0] ? ` on ${template().missing[0]}` : ''}</span></Show></>}</Show></div>
          <For each={templates().slice(0, shown()).map(template => template.id)}>{(id, index) => <Show when={templatesById().get(id)}>{template => <section class="ct-section" aria-label={`${template().name} template`}>
            <div class="ct-section-head"><span class="ct-marker">{String(index() + 1).padStart(2, '0')}</span><h2>{template().name}</h2><span class="ct-apparatus">{template().applied ? 'Enabled' : 'Draft · not in review'}</span>
              <Button disabled={busy()} onClick={() => setEditing(id)}>Edit</Button>
              <Show when={!template().applied} fallback={<Button disabled={busy()} onClick={() => void save(template(), { ...template(), applied: false })}>Disable · {template().units_active} cards</Button>}>
                <Button class="bordered" disabled={busy() || !template().front.trim() || !template().back.trim()} onClick={() => props.onOpen({ kind: 'cards', typeId: props.typeId, applyId: id }, false)}>Enable…</Button>
              </Show>
            </div>
            <Show when={editing() === id} fallback={<>
              <div class="ct-template-grid"><div class="ct-patterns">
                <div class="ct-pattern-line"><span class="ct-pattern-label">Front</span><PatternChips pattern={template().front} fields={data.latest?.fields ?? []} /></div>
                <div class="ct-pattern-line"><span class="ct-pattern-label">Back</span><PatternChips pattern={template().back} fields={data.latest?.fields ?? []} /></div>
                <p class="ct-footnote">Uses {usedFields(template().front, template().back).length} of {fields().length} fields</p>
              </div><div class="ct-preview"><Show when={template().preview} fallback={<p class="ct-apparatus">Waiting for a ready member</p>}>{preview => <>
                <div class="ct-preview-top"><span>Preview · {memberTitle(preview().member_text, id => props.notebook.lookup(id))}</span><span>1 / {template().ready}</span></div><p class="ct-preview-prompt">{preview().front}</p><p class="ct-preview-answer">{preview().back}</p>
              </>}</Show></div></div>
              <div class="ct-schedule"><label>New per day <input class="input ct-rate" type="number" min="1" max="9999" aria-label={`${template().name} new per day`} value={template().new_per_day} disabled={busy()} onChange={event => {
                const value = event.currentTarget.valueAsNumber;
                if (!Number.isInteger(value) || value < 1 || value > 9999) { setError('New per day must be between 1 and 9999.'); return; }
                if (value !== template().new_per_day) void save(template(), { ...template(), new_per_day: value });
              }} /></label><span>{template().ready} cards / {template().new_per_day} a day ≈ {Math.ceil(template().ready / template().new_per_day)} days</span></div>
            </>}><TemplateEditor template={template()} fields={data.latest?.fields ?? []} templateFields={data.latest?.type.fields ?? []} busy={busy()} onCancel={() => setEditing(null)} onSave={value => save(template(), value)} onDelete={() => save(template(), null)} /></Show>
          </section>}</Show>}</For>
          <Show when={templates().length > shown()}><Button onClick={() => setShown(value => value + 20)}>Show more templates</Button></Show>
          <div class="ct-bottom-rule"><Button class="bordered" disabled={busy()} onClick={async () => {
            const id = await save(null, { type_id: props.typeId, name: `Template ${templates().length + 1}`, front: '', back: '', applied: false, new_per_day: 10 });
            if (id) setEditing(id);
          }}>+ Add template</Button><span class="ct-inline-rule" /><span class="ct-apparatus">{templates().length && templates().every(template => template.ready === first()?.ready) ? `${first()!.ready} ready × ${templates().length} templates = ` : ''}{total()} cards</span></div>
          <section class="ct-foot"><div class="ct-section-head"><h3>Fields available to patterns</h3><Button onClick={event => props.onOpen({ kind: 'fields', typeId: props.typeId }, event.shiftKey)}>Open Fields →</Button></div><div class="ct-field-order"><For each={fields()}>{field => <span class="ct-chip">{field.name}</span>}</For></div><p>A member waits until every field used by the pattern has a value.</p></section>
          <p class="ct-footnote">Existing review progress is kept when a field value changes.</p>
        </>}>
          <Show when={applyTemplate()} fallback={<p class="empty-state">Template not found. <Button onClick={toCards}>Open Cards</Button></p>}>{template => <>
            <section class="ct-section ct-apply-view"><div class="ct-section-head"><span class="ct-marker">01</span><h2>Enable {template().name} on #{title()}</h2></div><p>One card per ready member. Check the size and pace before adding them to review.</p>
              <Show when={forecast.latest} fallback={<p role="status">Checking members…</p>}>{value => <>
                <div class="ct-forecast-counts"><div><strong>{value().cards_to_create}</strong><span>cards to create</span></div><div><strong>{value().waiting_total}</strong><span>waiting{template().missing[0] ? ` on ${template().missing[0]}` : ''}</span></div><p class="ct-apparatus">{value().members} members checked<br />0 existing reviews changed</p></div>
                <section class="ct-section"><div class="ct-section-head"><h3>Introduction schedule</h3><span class="ct-apparatus">{value().ready} / {value().new_per_day} = {(value().ready / value().new_per_day).toFixed(1)} → {value().days_to_introduce} days</span></div>
                  <div class="ct-schedule"><label>New per day <input class="input ct-rate" type="number" min="1" max="9999" aria-label="Apply new per day" value={template().new_per_day} disabled={busy()} onChange={event => {
                    const limit = event.currentTarget.valueAsNumber;
                    if (!Number.isInteger(limit) || limit < 1 || limit > 9999) { setError('New per day must be between 1 and 9999.'); return; }
                    if (limit !== template().new_per_day) void save(template(), { ...template(), new_per_day: limit });
                  }} /></label><span>Last ready card · {value().last_day ?? 'None'}</span></div>
                </section>
                <section class="ct-section"><div class="ct-section-head"><h3>Effect on daily review load</h3><span class="ct-apparatus">Next 14 days</span></div><LoadChart load={value().load} /><div class="ct-chart-key"><span>Existing reviews</span><span>Added new cards</span><span class="ct-apparatus">Not an FSRS prediction</span></div></section>
                <Show when={value().waiting_total > 0}>
                <section class="ct-section"><div class="ct-section-head"><h3>Waiting list</h3><span class="ct-apparatus">{value().waiting_total} members · no empty cards created</span></div><div class="ct-waiting-list"><For each={value().waiting.slice(0, 5)}>{member => <Button title={member.missing.join(', ')} onClick={async event => {
                  const beside = event.shiftKey;
                  try { const block = await props.notebook.api.block(member.id); props.onOpen({ kind: 'page', pageId: block.page_id, ...(block.parent_id ? { blockId: member.id } : {}) }, beside); }
                  catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
                }}>{memberTitle(member.text, id => props.notebook.lookup(id))}</Button>}</For>
                  <Button onClick={event => {
                    const field = data.latest?.fields.find(field => field.name === template().missing[0]);
                    const query = typeQuery(props.typeId);
                    if (field) query.filters = [{ field: field.id, op: 'empty', value: null }];
                    props.onOpen({ kind: 'table', typeId: props.typeId, viewId: null, query }, event.shiftKey);
                  }}>Show all {value().waiting_total} →</Button></div></section>
                </Show>
                <footer class="ct-apply-footer"><div><p class="ct-apparatus">from #{title()} · {template().name}</p><p>Apply keeps existing review progress.</p></div><Button disabled={busy()} onClick={toCards}>Cancel</Button><Button class="bordered ct-apply" disabled={busy() || template().applied || forecast.loading} onClick={async () => {
                  if (await save(template(), { ...template(), applied: true })) toCards();
                }}>Apply · {value().ready} cards</Button></footer>
              </>}</Show>
            </section>
          </>}</Show>
        </Show>
      </Show>
      <div class="ct-history"><Button disabled={busy() || !doc().canUndo()} onClick={() => void history(false)}>Undo</Button><Button disabled={busy() || !doc().canRedo()} onClick={() => void history(true)}>Redo</Button></div>
    </div>
  </div>;
}

function PatternChips(props: { pattern: string; fields: readonly FieldDefinition[] }) {
  const parts = createMemo(() => patternParts(props.pattern));
  return <span class="ct-pattern-text"><For each={parts()}>{part => part.field ? <span class="ct-chip">{'{'}{props.fields.find(field => field.id === part.text)?.name ?? part.text}{'}'}</span> : part.text.replaceAll('\\{', '{')}</For></span>;
}

function TemplateEditor(props: { template: CardTemplateInfo; fields: readonly FieldDefinition[]; templateFields: readonly string[]; busy: boolean; onCancel(): void; onSave(value: CardTemplateState): Promise<unknown>; onDelete(): Promise<unknown> }) {
  const [name, setName] = createSignal(props.template.name);
  const [front, setFront] = createSignal(displayPattern(props.template.front, props.fields));
  const [back, setBack] = createSignal(displayPattern(props.template.back, props.fields));
  const [problem, setProblem] = createSignal('');
  const [picker, setPicker] = createSignal<{ input: HTMLInputElement; side: 'front' | 'back'; at: number } | null>(null);
  function change(input: HTMLInputElement, side: 'front' | 'back') {
    (side === 'front' ? setFront : setBack)(input.value);
    const at = input.selectionStart ?? input.value.length;
    if (input.value[at - 1] === '{' && input.value[at - 2] !== '\\') setPicker({ input, side, at: at - 1 });
  }
  return <form class="ct-editor" onSubmit={async event => {
    event.preventDefault(); setProblem('');
    try { await props.onSave({ ...props.template, name: name(), front: storedPattern(front(), props.fields), back: storedPattern(back(), props.fields) }); }
    catch (reason) { setProblem(reason instanceof Error ? reason.message : String(reason)); }
  }}>
    <label>Name<input class="input" aria-label="Template name" value={name()} onInput={event => setName(event.currentTarget.value)} /></label>
    <label>Front<input class="input ct-pattern-input" aria-label="Front pattern" value={front()} onInput={event => change(event.currentTarget, 'front')} /></label>
    <label>Back<input class="input ct-pattern-input" aria-label="Back pattern" value={back()} onInput={event => change(event.currentTarget, 'back')} /></label>
    <p class="ct-footnote">Type {'{'} to choose a field. Use {'\\{'} for a literal brace.</p>
    <Show when={problem()}><p role="alert" class="error">{problem()}</p></Show>
    <div class="ct-editor-actions"><Button type="submit" class="bordered" disabled={props.busy}>Save template</Button><Button disabled={props.busy} onClick={props.onCancel}>Cancel</Button><Button disabled={props.busy} onClick={() => void props.onDelete()}>Delete template</Button></div>
    <Show when={picker()}>{value => <FieldPicker anchor={value().input} label="Pattern field" fields={props.fields} template={props.templateFields} onDismiss={() => setPicker(null)} onPick={field => {
      const current = value();
      const text = current.side === 'front' ? front() : back();
      const token = `{${props.fields.filter(candidate => candidate.name === field.name).length > 1 ? field.id : field.name}}`;
      const next = text.slice(0, current.at) + token + text.slice(current.at + 1);
      (current.side === 'front' ? setFront : setBack)(next);
      setPicker(null);
      requestAnimationFrame(() => { current.input.focus(); current.input.setSelectionRange(current.at + token.length, current.at + token.length); });
    }} />}</Show>
  </form>;
}

/** A member's text as a title: references read as their targets, type tags dropped. */
function memberTitle(text: string, lookup: NotebookClient['lookup']): string {
  return textTokens(text).filter(token => token.kind !== 'tag').map(token => isStableReference(token) ? referenceLabel(token, lookup(token.id!)()) : token.value).join('').replace(/\s+/g, ' ').trim();
}

function LoadChart(props: { load: { date: string; due: number; added: number }[] }) {
  const max = () => Math.max(1, ...props.load.map(day => day.due + day.added));
  return <svg class="ct-load-chart" viewBox="0 0 760 166" role="img" aria-label="Daily existing reviews and added new cards">
    <line x1="0" y1="130" x2="760" y2="130" stroke="var(--line)" />
    <For each={props.load}>{(day, index) => {
      const x = () => index() * (760 / props.load.length) + 12;
      const due = () => day.due / max() * 100;
      const added = () => day.added / max() * 100;
      return <g><title>{day.date}: {day.due} existing reviews, {day.added} added new cards</title><rect x={x()} y={130 - due()} width="24" height={due()} fill="var(--muted)" opacity="0.45" /><rect x={x()} y={130 - due() - added()} width="24" height={added()} fill="var(--calendar-scheduled)" opacity="0.8" /><text x={x() + 12} y="18" text-anchor="middle">{day.due + day.added}</text><text x={x() + 12} y="153" text-anchor="middle">{new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }).slice(0, 2)}</text></g>;
    }}</For>
  </svg>;
}
