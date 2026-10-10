import { For, Show, createEffect, createMemo, createResource, createSignal } from 'solid-js';
import type { EditorView } from '@codemirror/view';
import type { Block, FieldDefinition, TaskStatus } from '../api/types';
import { api } from '../api/client';
import type { BlockState, Caret } from '../document/contract';
import { fieldEntryId } from '../table/query';
import { kindLabels } from '../fields/kinds';
import { typeKeys } from '../fields/templates';
import { DatePicker } from '../tasks/DatePicker';
import { dateSuggestions, dateTokenAt, flipDateToken, newTask, planDateToken, removeToken } from '../tasks/quick-date';
import type { DateSuggestion, DateToken } from '../tasks/quick-date';
import { statusIcons, statusLabels } from '../tasks/TaskControls';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { BlockBreadcrumb, BlockText } from './BlockText';
import { completeReferences, openReferenceRange } from './completion';
import { nextClozeNumber, rankSlash, slashTokenAt } from './slash';
import type { SlashEntry, SlashToken } from './slash';
import { typeSpelling, typeTokenAt } from './type-completion';
import { addFieldOption } from './source-fields';
import type { OutlineContext } from './context';
import { createPageIcon } from './source';

/**
 * An open `[[` page reference or `((` block reference, a `#` type query, `::` at the start of a block
 * naming a field, the value of a choice field picking an option, or the manual Add type picker.
 */
export interface Completion { from: number; to: number; query: string; types?: boolean; blocks?: boolean; fields?: boolean; choice?: FieldDefinition; manual?: { blockId: string; anchor: HTMLElement } }
/** A slash-menu row: a block verb (`run`) or syntax that replaces the token (`insert`), or both. */
interface SlashItem extends SlashEntry {
  section: string;
  icon: IconName;
  keys?: string;
  when?(block: BlockState | undefined): boolean;
  disabledReason?(id: string): string | undefined;
  insert?(text: string): { text: string; caret: number };
  run?(id: string): void;
}
type CompletionRow = { kind: 'block'; block: Block } | { kind: 'field'; field: FieldDefinition } | { kind: 'option'; option: FieldDefinition['options'][number] };
export function createOutlineCompletions(context: Pick<OutlineContext,
  | 'contextDate' | 'editing' | 'textRange' | 'composition' | 'caret'
  | 'editor' | 'doc' | 'capabilities' | 'setCaret' | 'scheduleReport'
  | 'setMessage' | 'disposed' | 'rowAnchor' | 'editAt' | 'props'
  | 'replaceSelection' | 'fields' | 'definitionsById' | 'definitions' | 'activeRange'
  | 'fieldConversion' | 'commandDefinitions' | 'openPlanning' | 'priorityMenu' | 'openProject'
  | 'investigationItems' | 'apply' | 'zoomTo' | 'copy' | 'templateFor'
>) {
  const {
    contextDate, editing, textRange, composition, caret, doc,
    capabilities, setCaret, scheduleReport, setMessage, rowAnchor, editAt,
    props, replaceSelection, fields, definitionsById, definitions, activeRange,
    fieldConversion, openPlanning, priorityMenu, openProject, investigationItems, apply,
    zoomTo, copy, templateFor,
  } = context;
  const [completion, setCompletion] = createSignal<Completion | null>(null);
  const [completionIndex, setCompletionIndex] = createSignal(0);
  const [dateCompletion, setDateCompletion] = createSignal<(DateToken & { id: string }) | null>(null);
  const [dateIndex, setDateIndex] = createSignal(0);
  const [slashCompletion, setSlashCompletion] = createSignal<(SlashToken & { id: string }) | null>(null);
  const [slashIndex, setSlashIndex] = createSignal(0);
  let completionList: HTMLDivElement | undefined;
  let slashList: HTMLDivElement | undefined;
  /** `@` offers dates; choosing one makes the block a scheduled task (or a deadline after `@by`/`@due`) and removes the token. */
  const dateRows = createMemo<DateSuggestion[]>(() => { const state = dateCompletion(); return state ? dateSuggestions(state.query, contextDate()) : []; });
  createEffect(() => { if (dateCompletion() && editing() !== dateCompletion()!.id) setDateCompletion(null); });
  createEffect(() => { if (slashCompletion() && editing() !== slashCompletion()!.id) setSlashCompletion(null); });
  let dismissedDate: { id: string; from: number } | null = null;
  let dismissedSlash: { id: string; from: number } | null = null;
  /** One trigger at a time: a slash command being typed wins over an `@` before it. */
  function updateTriggers(text: string, at: Caret) {
    const idle = textRange() || composition();
    if (dismissedSlash && (dismissedSlash.id !== at.id || text[dismissedSlash.from] !== '/')) dismissedSlash = null;
    const slash = idle ? null : slashTokenAt(text, at.offset);
    if (slash && dismissedSlash?.from !== slash.from) {
      if (slashCompletion()?.query !== slash.query) setSlashIndex(0);
      setSlashCompletion({ ...slash, id: at.id });
      setDateCompletion(null);
      return;
    }
    setSlashCompletion(null);
    if (dismissedDate && (dismissedDate.id !== at.id || text[dismissedDate.from] !== '@')) dismissedDate = null;
    const token = idle ? null : dateTokenAt(text, at.offset);
    // Once a multi-word `@` query matches no date it is prose (`@sam about the report`), so the picker
    // closes and Enter splits the block as usual; it reopens if the words become a date again.
    const prose = token && /\s/.test(token.query.trim()) && !dateSuggestions(token.query, contextDate()).length;
    if (!token || prose || dismissedDate?.from === token.from) { setDateCompletion(null); return; }
    if (dateCompletion()?.query !== token.query || dateCompletion()?.field !== token.field) setDateIndex(0);
    setDateCompletion({ ...token, id: at.id });
  }
  function dismissDate() {
    const state = dateCompletion();
    if (state) dismissedDate = { id: state.id, from: state.from };
    setDateCompletion(null);
  }
  /** Replaces the live token in the editor with `next`, keeping the document and caret in step. */
  function rewriteEditing(id: string, next: { text: string; caret: number }): boolean {
    if (!context.editor || context.editor.id !== id) return false;
    const result = doc.edit({ kind: 'text', id, text: next.text }, caret());
    if (!result.ok) { capabilities.failure(id, result.reason); return false; }
    context.editor.sync(next.text);
    context.editor.view.dispatch({ selection: { anchor: next.caret } });
    setCaret({ id, offset: next.caret });
    return true;
  }
  function chooseDate(index = dateIndex()) {
    const state = dateCompletion();
    const id = editing();
    if (!state || !context.editor || id !== state.id || context.editor.id !== id) return;
    const text = context.editor.view.state.doc.toString();
    const choice = dateRows()[index] ?? null;
    const plan = planDateToken(text, state, choice, doc.block(id)?.task ?? null);
    setDateCompletion(null);
    const result = doc.edit({ kind: 'planTask', id, text: plan.text, value: plan.value }, caret());
    if (!result.ok) { capabilities.failure(id, result.reason); return; }
    context.editor.sync(plan.text);
    context.editor.view.dispatch({ selection: { anchor: plan.caret } });
    setCaret({ id, offset: plan.caret });
    void doc.flush().catch(reason => capabilities.failure(id, reason));
    if (!choice) capabilities.open(id, state.field === 'deadline' ? 'deadline' : 'schedule');
    scheduleReport();
  }
  function flipDateField() {
    const state = dateCompletion();
    const id = editing();
    if (!state || !context.editor || id !== state.id || context.editor.id !== id) return;
    const next = flipDateToken(context.editor.view.state.doc.toString(), state);
    if (rewriteEditing(id, next)) updateTriggers(next.text, { id, offset: next.caret });
  }
  function dateKey(event: KeyboardEvent) {
    if (!dateCompletion()) return false;
    const count = dateRows().length + 1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { setDateIndex(index => Math.max(0, Math.min(count - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); return true; }
    if (event.key === 'Tab' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) { flipDateField(); return true; }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) { chooseDate(); return true; }
    if (event.key === 'Escape') { dismissDate(); return true; }
    return false;
  }
  const slashRows = createMemo<SlashItem[]>(() => {
    const state = slashCompletion();
    if (!state) return [];
    const block = doc.block(state.id);
    return rankSlash(slashItems().filter(item => !item.when || item.when(block)), state.query);
  });
  function dismissSlash() {
    const state = slashCompletion();
    if (state) dismissedSlash = { id: state.id, from: state.from };
    setSlashCompletion(null);
  }
  /** Removes `/query` (or swaps it for the item's syntax), then runs the item on the block. */
  function chooseSlash(index = slashIndex()) {
    const state = slashCompletion();
    const id = editing();
    const item = slashRows()[index];
    if (!state || !item || !context.editor || id !== state.id || context.editor.id !== id) return;
    const disabled = item.disabledReason?.(id);
    if (disabled) { setMessage(disabled); return; }
    const text = context.editor.view.state.doc.toString();
    const insertion = item.insert?.(text);
    const next = insertion
      ? { text: text.slice(0, state.from) + insertion.text + text.slice(state.to), caret: state.from + insertion.caret }
      : removeToken(text, state);
    setSlashCompletion(null);
    if (!rewriteEditing(id, next)) return;
    if (insertion) { updateCompletion(next.text, { id, offset: next.caret }); updateTriggers(next.text, { id, offset: next.caret }); }
    void doc.flush().catch(reason => capabilities.failure(id, reason));
    item.run?.(id);
    scheduleReport();
  }
  createEffect(() => { slashIndex(); slashRows(); requestAnimationFrame(() => slashList?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })); });
  function slashKey(event: KeyboardEvent) {
    if (!slashCompletion()) return false;
    const count = slashRows().length;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count) { setSlashIndex(index => Math.max(0, Math.min(count - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); return true; }
    if ((event.key === 'Enter' || event.key === 'Tab') && count && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) { chooseSlash(); return true; }
    if (event.key === 'Escape') { dismissSlash(); return true; }
    return false;
  }
  const [valueDate, setValueDate] = createSignal<{ id: string; anchor: HTMLElement } | null>(null);
  /** A new entry for a choice, date or instance field opens the matching picker for its empty value. */
  function offerValue(id: string, field: FieldDefinition) {
    if (field.kind !== 'choice' && field.kind !== 'date' && field.kind !== 'instance') return;
    requestAnimationFrame(() => {
      if (context.disposed || editing() !== id || doc.block(id)?.text) return;
      if (field.kind === 'choice') { setCompletionIndex(0); setCompletion({ from: 0, to: 0, query: '', choice: field }); return; }
      if (field.kind === 'instance') {
        // The editor may still be mounting this new value, so the caret goes in through a focus request, not the live view.
        const result = doc.edit({ kind: 'text', id, text: '[[]]' }, caret());
        if (!result.ok) { setMessage(result.reason); return; }
        editAt(id, 2, true, false, false);
        queueMicrotask(() => { if (editing() === id) updateCompletion('[[]]', { id, offset: 2 }); });
        return;
      }
      const anchor = rowAnchor(id);
      if (anchor) setValueDate({ id, anchor });
    });
  }
  function chooseValueDate(id: string, date: string | null) {
    if (!date) return;
    const result = doc.edit({ kind: 'text', id, text: date }, caret());
    if (!result.ok) { setMessage(result.reason); return; }
    editAt(id, date.length, true);
  }
  function popupKey(event: KeyboardEvent) {
    if (!completion()) return false;
    const count = completionRows().length + (canCreate() ? 1 : 0);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { setCompletionIndex(index => Math.max(0, Math.min(count - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); return true; }
    if (event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey) { void chooseCompletion(); return true; }
    if (event.key === 'Escape') { dismissCompletion(); return true; }
    return false;
  }
  /**
   * Where a chosen reference left a separating space, punctuation or a space typed next takes its place. This
   * listens to text input, not keys, because phone keyboards report printable keys as `Unidentified`.
   */
  let referenceSpace: Caret | null = null;
  function referenceInput(view: EditorView, from: number, to: number, text: string) {
    const at = referenceSpace;
    referenceSpace = null;
    if (!at || at.id !== editing() || from !== to || from !== at.offset || !/^[ .,;:!?)]$/.test(text)) return false;
    const selection = view.state.selection.main;
    if (!selection.empty || selection.head !== at.offset || view.state.doc.sliceString(at.offset - 1, at.offset) !== ' ') return false;
    if (text !== ' ') view.dispatch({ changes: { from: at.offset - 1, to: at.offset, insert: text }, selection: { anchor: at.offset }, userEvent: 'input.type' });
    return true;
  }
  /** A navigation or deletion key first leaves the space as it is. */
  function forgetReferenceSpace(event: KeyboardEvent) {
    if (event.key.length > 1 && !['Shift', 'CapsLock', 'Unidentified', 'Process', 'Dead'].includes(event.key)) referenceSpace = null;
    return false;
  }
  /** Escape closes the completion; it stays closed while the same query is under the caret, and reopens once the text changes. */
  let dismissedCompletion: { id: string; from: number; query: string } | null = null;
  function dismissCompletion() {
    const state = completion();
    if (state && !state.manual && context.editor) dismissedCompletion = { id: context.editor.id, from: state.from, query: state.query };
    setCompletion(null);
  }
  /**
   * `::` at the start of a block picks a field, and a choice field's value picks an option. Otherwise `[[`
   * completes pages, fields and blocks and `((` searches blocks only; both insert a `[[id]]` reference.
   */
  function completionAt(text: string, at: Caret): Completion | null {
    if (text.startsWith('::') && at.offset >= 2) {
      const query = text.slice(2, at.offset);
      return /[\\`[\]#:\n]/.test(query) ? null : { from: 0, to: at.offset, query, fields: true };
    }
    const parent = doc.outline.parentOf(at.id);
    const field = parent ? definitionsById().get(fieldEntryId(doc.block(parent)?.text ?? '') ?? '') : undefined;
    if (field?.kind === 'choice') return text.includes('[[') || text.includes('\n') ? null : { from: 0, to: text.length, query: text, choice: field };
    const typeToken = typeTokenAt(text, at.offset);
    if (typeToken) return { ...typeToken, types: true };
    const prefix = text.slice(0, at.offset);
    const page = prefix.lastIndexOf('[['), block = prefix.lastIndexOf('((');
    const blocks = block > page, from = Math.max(page, block);
    const query = prefix.slice(from + 2);
    if (from < 0 || query.includes(blocks ? ')' : ']') || query.includes('\n') || !blocks && prefix[from - 1] === '#') return null;
    return { from, to: at.offset, query, blocks };
  }
  function updateCompletion(text: string, at: Caret) {
    if (completion()?.manual) return;
    const next = completionAt(text, at);
    if (!next) { setCompletion(null); return; }
    if (dismissedCompletion && dismissedCompletion.id === at.id && dismissedCompletion.from === next.from && dismissedCompletion.query === next.query) return;
    dismissedCompletion = null;
    if (completion()?.query !== next.query) setCompletionIndex(0);
    setCompletion(next);
  }
  // A primitive key: every keystroke sets a fresh completion object, and the same query must not fetch twice.
  const completionKey = createMemo(() => {
    const state = completion();
    return state && !state.fields && !state.choice ? `${state.manual || state.types ? 'types' : state.blocks ? 'blocks' : 'text'}:${state.query}` : false;
  });
  const [matches] = createResource(completionKey, async key => {
    const mode = key.slice(0, key.indexOf(':'));
    const query = key.slice(key.indexOf(':') + 1);
    if (mode === 'types') return completeReferences(props.notebook, query, []);
    if (mode === 'blocks') return { rows: query.trim() ? (await api.search(query, 20)).map(hit => hit.block).filter(block => block.kind === 'block') : [], canCreate: false };
    return { rows: await api.complete(query), canCreate: false };
  });
  const completionRows = createMemo<CompletionRow[]>(() => {
    const state = completion();
    if (state?.fields) {
      // Fields the owner's types template and it lacks come first, in template order; fields it already has come last.
      const query = state.query.trim().toLowerCase();
      const id = editing();
      const owner = id ? doc.block(doc.outline.parentOf(id)) : undefined;
      const template = owner ? templateFor(typeKeys(owner.text, owner.manual_types)) : [];
      const present = new Set(owner ? doc.outline.children(owner.id).flatMap(child => child !== id && !doc.isArchived(child) ? [fieldEntryId(doc.block(child)?.text ?? '') ?? ''] : []) : []);
      const rank = (field: FieldDefinition) => present.has(field.id) ? template.length + 2
        : template.includes(field.id) ? template.indexOf(field.id) : template.length + (field.name.toLowerCase().startsWith(query) ? 0 : 1);
      return definitions().filter(field => field.name.toLowerCase().includes(query)).map((field, index) => ({ field, index }))
        .sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index).map(({ field }) => ({ kind: 'field', field }));
    }
    if (state?.choice) {
      const query = state.query.trim().toLowerCase();
      return state.choice.options.filter(option => option.text.toLowerCase().includes(query)).map(option => ({ kind: 'option', option }));
    }
    // The block being typed in matches its own saved draft; it is never a useful target.
    const found = (matches.error ? [] : matches()?.rows ?? []).filter(block => block.id !== editing());
    if (state?.manual || state?.types) return found.filter(block => block.kind === 'page').map(block => ({ kind: 'block', block }));
    if (state?.blocks) return found.map(block => ({ kind: 'block', block }));
    const query = state?.query.toLowerCase() ?? '';
    const matchingFields = definitions().filter(field => field.name.toLowerCase().includes(query));
    const byId = new Map(matchingFields.map(field => [field.id, field]));
    const rows: CompletionRow[] = found.map(block => {
      const field = byId.get(block.id);
      byId.delete(block.id);
      return field ? { kind: 'field', field } : { kind: 'block', block };
    });
    for (const field of byId.values()) rows.push({ kind: 'field', field });
    return rows;
  });
  /** As in Find or create, a query that names nothing exactly offers Create page, Create field or Add option after the matches. */
  const canCreate = createMemo(() => {
    const state = completion();
    const title = state?.query.trim().toLocaleLowerCase();
    if (!state || !title || state.blocks) return false;
    if (state.fields) return !/[\\`[\]#:]/.test(title) && !definitions().some(field => field.name.toLocaleLowerCase() === title);
    if (state.choice) return !state.choice.options.some(option => option.text.toLocaleLowerCase() === title);
    if (matches.error) return false;
    if (state.manual || state.types) return !matches.loading && !!matches()?.canCreate;
    if (fields.loading || fields.error) return false;
    return !completionRows().some(row => (row.kind === 'field' ? row.field.name : row.kind === 'option' || row.block.kind === 'block' ? '' : row.block.text).toLocaleLowerCase() === title);
  });
  createEffect(() => {
    completionIndex();
    completionRows();
    if (!completion()) return;
    requestAnimationFrame(() => {
      if (completionList?.isConnected) completionList.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    });
  });
  /** The open query plus the closing brackets the editor paired with it, including any query text after the caret. */
  function completionRange(state: Completion, text: string) {
    return state.types || state.fields || state.choice ? { from: state.from, to: state.to } : openReferenceRange(text, state.from, state.to, !!state.blocks);
  }
  let drafted = false;
  createEffect(() => {
    const state = completion();
    if (!context.editor) return;
    if (state && !state.manual && !state.choice) { drafted = true; context.editor.markDraft(completionRange(state, context.editor.view.state.doc.toString())); }
    else if (drafted) { drafted = false; context.editor.markDraft(null); }
  });
  function insertReference(id: string) {
    const state = completion();
    const source = editing();
    if (!state || !context.editor || !source) return;
    const range = completionRange(state, context.editor.view.state.doc.toString());
    const next = context.editor.view.state.doc.sliceString(range.to, range.to + 1);
    // A word after the reference, or the end of the block, gets a separating space so typing continues as prose; an instance value is only its reference.
    const instance = definitionsById().get(fieldEntryId(doc.block(doc.outline.parentOf(source))?.text ?? '') ?? '')?.kind === 'instance' && range.from === 0 && !next;
    const space = !instance && (!next || /[\p{L}\p{N}]/u.test(next)) ? ' ' : '';
    const inserted = `[[${id}]]${space}`;
    const selectionBefore = activeRange() ?? undefined;
    setCompletion(null);
    replaceSelection(inserted, 'text', { anchor: { id: source, offset: range.from }, head: { id: source, offset: range.to } }, selectionBefore);
    referenceSpace = space ? { id: source, offset: range.from + inserted.length } : null;
  }
  /** Enter pressed before results arrive picks once they do, unless typing has changed the query since. */
  let chooseWhenReady: string | null = null;
  createEffect(() => {
    const loading = matches.loading;
    const query = completion()?.query;
    if (loading || chooseWhenReady === null) return;
    const wanted = chooseWhenReady;
    chooseWhenReady = null;
    if (query === wanted) void chooseCompletion();
  });
  async function chooseCompletion(index = completionIndex()) {
    const row = completionRows()[index];
    const state = completion();
    if (!state) return;
    if (state.fields) {
      const id = editing();
      const target = row?.kind === 'field' ? row.field : canCreate() ? state.query.trim() : null;
      if (id && target) fieldConversion.entry(id, target, state.to);
      return;
    }
    if (state.choice) {
      const id = editing();
      if (!id) return;
      try {
        const option = row?.kind === 'option' ? row.option.id : canCreate() ? await addFieldOption(props.notebook, state.choice, state.query.trim()) : null;
        if (!option || completion() !== state) return;
        setCompletion(null);
        replaceSelection(`[[${option}]]`, 'text', { anchor: { id, offset: 0 }, head: { id, offset: doc.block(id)?.text.length ?? 0 } });
      } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (state.manual) {
      if (matches.loading || matches.error) return;
      const title = row?.kind === 'block' ? row.block.text : canCreate() ? state.query.trim() : null;
      if (title) {
        const result = doc.addType(state.manual.blockId, title);
        if (!result.ok) setMessage(result.reason);
        setCompletion(null);
      }
      return;
    }
    if (matches.loading) { chooseWhenReady = state.query; return; }
    if (state.types) {
      const source = editing();
      const title = row?.kind === 'block' ? row.block.text : canCreate() ? state.query.trim() : null;
      if (!source || !context.editor || !title || matches.error) return;
      const inserted = `${typeSpelling(title)} `;
      const selectionBefore = activeRange() ?? undefined;
      setCompletion(null);
      // Text tags and Add type share the notebook's type-page derivation, including new page creation.
      replaceSelection(inserted, 'text', { anchor: { id: source, offset: state.from }, head: { id: source, offset: state.to } }, selectionBefore);
      referenceSpace = { id: source, offset: state.from + inserted.length };
      return;
    }
    if (row?.kind === 'field') { insertReference(row.field.id); return; }
    if (matches.error) return;
    if (row?.kind === 'block') { insertReference(row.block.id); return; }
    if (canCreate()) {
      try { const id = await props.notebook.createPage(state.query.trim()); insertReference(id); }
      catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    }
  }
  function caretRect(offset: number): DOMRect | null {
    const rect = context.editor?.view.coordsAtPos(offset);
    return rect ? new DOMRect(rect.left, rect.top, Math.max(1, rect.right - rect.left), rect.bottom - rect.top) : null;
  }
  /** The picker stays under the opening brackets while the query grows. */
  function completionAnchor(): DOMRect | null {
    const state = completion();
    if (state?.manual) return state.manual.anchor.getBoundingClientRect();
    return state && context.editor ? caretRect(state.from) : null;
  }
  /** The slash menu: block verbs from the command list plus syntax inserts; each row shows its faster key. */
  function slashItems(): SlashItem[] {
    const keys = (commandId: string) => context.commandDefinitions.find(command => command.id === commandId)?.keys?.[0];
    const status = (value: TaskStatus, aliases: string[]): SlashItem => ({ id: `status-${value}`, title: statusLabels[value], aliases, section: 'Task', icon: statusIcons[value], keys: value === 'todo' || value === 'done' ? keys('toggle-task') : undefined, run: id => capabilities.invoke(capabilities.status(id, value)) });
    return [
      status('todo', ['task', 'checkbox']),
      status('doing', ['start', 'in progress']),
      status('waiting', ['blocked', 'hold']),
      status('done', ['complete', 'finish']),
      status('cancelled', ['cancel']),
      { id: 'schedule', title: 'Schedule', aliases: ['date', 'scheduled', 'when'], section: 'Task', icon: 'calendar', keys: '@', run: id => openPlanning(id, 'schedule') },
      { id: 'deadline', title: 'Deadline', aliases: ['due'], section: 'Task', icon: 'warning', keys: '@due', run: id => openPlanning(id, 'deadline') },
      { id: 'priority', title: 'Priority', aliases: ['important', 'urgent'], section: 'Task', icon: 'up', keys: keys('priority-task'), run: priorityMenu },
      { id: 'repeat', title: 'Repeat', aliases: ['recur', 'recurring', 'every'], section: 'Task', icon: 'repeat', keys: keys('repeat-task'), run: id => openPlanning(id, 'repeat') },
      { id: 'clock', title: 'Clock in / out', aliases: ['timer', 'start work', 'stop work'], section: 'Task', icon: 'clock', keys: keys('clock'), run: id => capabilities.invoke(capabilities.clock(id)) },
      { id: 'remove-task', title: 'Remove task', aliases: ['plain'], section: 'Task', icon: 'close', when: block => !!block?.task, run: id => capabilities.invoke(capabilities.status(id, null)) },
      { id: 'project', title: 'Project', aliases: ['outcome'], section: 'Project', icon: 'flag', keys: 'Space o', run: openProject },
      { id: 'perspective', title: 'Make perspective', aliases: ['position', 'view'], section: 'Block', icon: 'link', keys: 'Space v', when: block => block?.kind === 'block' && !block.position, run: id => capabilities.invoke(capabilities.edit(id, { kind: 'position', id, value: true })) },
      { id: 'remove-perspective', title: 'Remove perspective', aliases: ['remove position', 'remove view'], section: 'Block', icon: 'close', keys: 'Space v', when: block => block?.kind === 'block' && !!block.position, run: id => capabilities.invoke(capabilities.edit(id, { kind: 'position', id, value: false })) },
      ...(['question', 'answer'] as const).map((kind): SlashItem => ({
        id: kind, title: `Make ${kind}`, aliases: [kind], section: 'Question', icon: kind === 'question' ? 'question-open' : 'question-settled', keys: 'Space q',
        disabledReason: id => investigationItems(id).find(item => item.label === `Make ${kind}`)?.disabledReason ?? (doc.block(id)?.[kind === 'question' ? 'question' : 'assessment'] ? `Already a ${kind}.` : undefined),
        run: id => {
          const item = investigationItems(id).find(item => item.label === `Make ${kind}`);
          if (item && !item.disabledReason) item.action();
        },
      })),
      ...([1, 2, 3] as const).map((level): SlashItem => ({ id: `heading-${level}`, title: `Heading ${level}`, aliases: [`h${level}`], section: 'Text', icon: 'heading', keys: '#'.repeat(level), run: id => apply({ kind: 'heading', id, level }) })),
      { id: 'heading-normal', title: 'Normal text', aliases: ['paragraph'], section: 'Text', icon: 'edit', when: block => !!block?.heading, run: id => apply({ kind: 'heading', id, level: null }) },
      { id: 'reference', title: 'Reference', aliases: ['link', 'page', 'mention'], section: 'Text', icon: 'link', keys: '[[', insert: () => ({ text: '[[', caret: 2 }) },
      { id: 'type', title: 'Type', aliases: ['tag', 'supertag'], section: 'Text', icon: 'tag', keys: '#', insert: () => ({ text: '#', caret: 1 }) },
      { id: 'card', title: 'Card', aliases: ['flashcard'], section: 'Cards', icon: 'right', keys: '>>', insert: () => ({ text: '>> ', caret: 3 }) },
      { id: 'reversible-card', title: 'Reversible card', aliases: ['both ways', 'flashcard'], section: 'Cards', icon: 'panes', keys: '<>', insert: () => ({ text: '<> ', caret: 3 }) },
      { id: 'cloze', title: 'Cloze', aliases: ['blank', 'fill in', 'flashcard'], section: 'Cards', icon: 'select', keys: '{{c1::}}', insert: text => { const cloze = `{{c${nextClozeNumber(text)}::}}`; return { text: cloze, caret: cloze.length - 2 }; } },
      { id: 'zoom', title: 'Zoom in', aliases: ['focus'], section: 'Block', icon: 'bullet', keys: '⌘.', run: id => zoomTo(id) },
      { id: 'copy-reference', title: 'Copy reference', section: 'Block', icon: 'copy', run: id => copy(`[[${id}]]`) },
    ];
  }
  /** Typing `[] ` or `[ ] ` at the start of a plain block makes it a task. */
  function taskPrefix(text: string, at: Caret): boolean {
    const prefix = /^\[ ?\] /.exec(text)?.[0];
    if (!prefix || at.offset !== prefix.length || composition() || doc.block(at.id)?.task) return false;
    const rest = text.slice(prefix.length);
    const result = doc.edit({ kind: 'planTask', id: at.id, text: rest, value: newTask() }, caret());
    if (!result.ok) { setMessage(result.reason); return true; }
    queueMicrotask(() => { if (context.editor?.id !== at.id) return; context.editor.sync(rest); context.editor.view.dispatch({ selection: { anchor: 0 } }); });
    setCaret({ id: at.id, offset: 0 });
    void doc.flush().catch(reason => capabilities.failure(at.id, reason));
    return true;
  }
function CompletionPopups(){ return <>
    <Show when={completion()}><Popup anchor={completionAnchor} width={480} class="picker" label={completion()?.manual ? 'Add type…' : completion()?.types ? 'Type' : completion()?.fields ? 'Field' : completion()?.choice ? `${completion()!.choice!.name} options` : completion()?.blocks ? 'Block reference' : 'Reference completion'} role={completion()?.manual ? 'dialog' : 'listbox'} onDismiss={dismissCompletion} autofocus={!!completion()?.manual}>
      <Show when={completion()?.manual}><div class="picker-query"><Icon name="tag" class="picker-prefix" /><input class="picker-input" aria-label="Type title" placeholder="Type title" value={completion()?.query ?? ''} onInput={event => { setCompletion(state => state ? { ...state, query: event.currentTarget.value } : null); setCompletionIndex(0); }} onKeyDown={event => { if (!event.isComposing && popupKey(event)) { event.preventDefault(); event.stopPropagation(); } }} /></div></Show>
      <div ref={completionList} class="picker-list" onMouseDown={event => event.preventDefault()}>
        <Show when={completionKey() && matches.loading && !completionRows().length && !canCreate()}><p class="empty-state">Searching…</p></Show>
        <Show when={completionKey() && matches.error}><p class="error" role="alert">Couldn't load completion.</p></Show>
        <For each={completionRows()}>{(row, index) => <div role="option" aria-selected={completionIndex() === index()} class="picker-row" classList={{ selected: completionIndex() === index() }} onClick={() => void chooseCompletion(index())}>
          <Show when={row.kind === 'block' ? row.block : null}>{block => {
            const icon = createPageIcon(props.notebook, block);
            return <><Icon name={icon()} /><span class="picker-text">{block().text ? <BlockText text={block().text} notebook={props.notebook} interactive={false} /> : 'Empty block'}</span><Show when={block().kind === 'block'}><span class="picker-meta"><BlockBreadcrumb block={block()} notebook={props.notebook} /></span></Show></>;
          }}</Show>
          <Show when={row.kind === 'field' ? row.field : null}>{field => <><Icon name="field" /><span class="picker-text">{field().name}</span><span class="picker-meta">{completion()?.fields ? kindLabels[field().kind] : 'Field'}</span></>}</Show>
          <Show when={row.kind === 'option' ? row.option : null}>{option => <><Icon name="bullet" /><span class="picker-text">{option().text}</span></>}</Show>
        </div>}</For>
        <Show when={canCreate()}><div role="option" aria-selected={completionIndex() === completionRows().length} class="picker-row" classList={{ selected: completionIndex() === completionRows().length }} onClick={() => void chooseCompletion(completionRows().length)}><Icon name="plus" /><span class="picker-text">{completion()?.fields ? 'Create field' : completion()?.choice ? 'Add option' : completion()?.types ? 'Create type' : 'Create page'} “{completion()?.query.trim()}”</span></div></Show>
        <Show when={!(completionKey() && (matches.loading || matches.error)) && !canCreate() && !completionRows().length}><p class="empty-state">{
          completion()?.fields ? 'Type a field name.' : completion()?.choice ? 'Type an option to add it.' : completion()?.blocks && !completion()?.query.trim() ? 'Type to search blocks.' : 'No matching blocks.'
        }</p></Show>
      </div>
    </Popup></Show>
    <Show keyed when={valueDate()}>{state => <DatePicker notebook={props.notebook} anchor={state.anchor} label="Date" value={null} contextDate={contextDate()}
      onDismiss={() => { setValueDate(null); if (editing() === state.id) editAt(state.id, doc.block(state.id)?.text.length ?? 0, true); }} onSelect={value => chooseValueDate(state.id, value.date)} />}</Show>
    <Show when={dateCompletion()}><Popup anchor={() => caretRect(dateCompletion()?.from ?? 0)} width={320} class="picker" label={dateCompletion()?.field === 'deadline' ? 'Deadline' : 'Scheduled'} role="listbox" onDismiss={dismissDate}>
      <div class="picker-list" onMouseDown={event => event.preventDefault()}>
        <div class="picker-row" role="presentation"><span class="picker-text">{dateCompletion()?.field === 'deadline' ? 'Deadline' : 'Scheduled'}</span><span class="picker-meta"><kbd>Tab</kbd></span></div>
        <For each={dateRows()}>{(row, index) => <div role="option" aria-selected={dateIndex() === index()} class="picker-row" classList={{ selected: dateIndex() === index() }} onClick={() => chooseDate(index())}>
          <Icon name={dateCompletion()?.field === 'deadline' ? 'warning' : 'calendar'} /><span class="picker-text">{row.label}</span><span class="picker-meta">{row.date}</span>
        </div>}</For>
        <Show when={!dateRows().length}><p class="empty-state">No matching date</p></Show>
        <div role="option" aria-selected={dateIndex() === dateRows().length} class="picker-row" classList={{ selected: dateIndex() === dateRows().length }} onClick={() => chooseDate(dateRows().length)}>
          <Icon name="more" /><span class="picker-text">Pick a date…</span>
        </div>
      </div>
    </Popup></Show>
    <Show when={slashCompletion()}><Popup anchor={() => caretRect(slashCompletion()?.from ?? 0)} width={320} class="picker" label="Commands" role="listbox" onDismiss={dismissSlash}>
      <div ref={slashList} class="picker-list" onMouseDown={event => event.preventDefault()}>
        <For each={slashRows()}>{(row, index) => <>
          <Show when={index() === 0 || slashRows()[index() - 1]!.section !== row.section}><div class="picker-section">{row.section}</div></Show>
          <div role="option" aria-selected={slashIndex() === index()} aria-disabled={!!row.disabledReason?.(slashCompletion()!.id)} title={row.disabledReason?.(slashCompletion()!.id)} class="picker-row" classList={{ selected: slashIndex() === index() }} onClick={() => chooseSlash(index())}>
            <Icon name={row.icon} /><span class="picker-text">{row.title}</span><Show when={row.keys}><span class="picker-meta"><kbd>{row.keys}</kbd></span></Show>
            <Show when={row.disabledReason?.(slashCompletion()!.id)}>{reason => <span class="picker-meta">{reason()}</span>}</Show>
          </div>
        </>}</For>
        <Show when={!slashRows().length}><p class="empty-state">No matching command. Escape keeps the text.</p></Show>
      </div>
    </Popup></Show>
</>; }
  return { setCompletion, setCompletionIndex, offerValue, updateCompletion, updateTriggers, taskPrefix, rewriteEditing, referenceInput, forgetReferenceSpace, slashKey, dateKey, popupKey, CompletionPopups };
}
