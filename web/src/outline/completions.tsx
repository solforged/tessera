import { For, Show, createEffect, createMemo, createResource, createSignal } from 'solid-js';
import type { EditorView } from '@codemirror/view';
import type { Block, Completion as NameCompletion, FieldDefinition, RelationKind, TaskStatus } from '../api/types';
import { api } from '../api/client';
import type { BlockState, Caret } from '../document/contract';
import { fieldEntryId } from '../table/query';
import { kindLabels } from '../fields/kinds';
import { typeKeys } from '../fields/templates';
import { ValueEditor, writeFieldValue } from '../fields/value-editor';
import { hasValueEditor } from '../fields/value-options';
import { createOptionValue } from '../fields/commands';
import { DatePicker } from '../tasks/DatePicker';
import { dateQueryError, dateSuggestions, dateTokenAt, flipDateToken, newTask, planDateToken, removeToken } from '../tasks/quick-date';
import type { DateSuggestion, DateToken } from '../tasks/quick-date';
import { statusIcons, statusLabels } from '../tasks/TaskControls';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { BlockBreadcrumb, BlockText } from './BlockText';
import { captureQuoteCompletion, completedReference, completionPickKey, completionTakesKey, engagedToken, isJournalReference, isQuoteCompletion, openReferenceRange, referenceAliasInput, referenceCompletionAt, referenceNewlineAt } from './completion';
import type { CompletionToken } from './completion';
import { rankSlash, slashTokenAt } from './slash';
import { insertCard } from './card-insert';
import type { InsertCardKind } from './card-insert';
import type { SlashEntry, SlashToken } from './slash';
import { completeTypes, typeChoiceSpelling, typeTokenAt } from './type-completion';
import type { OutlineContext } from './context';
import { createPageIcon } from './source';
import { emptyExtraValuePrevious } from './keyboard';
import { addRelationReason, relationKinds, relationLabels, relationReason } from './relations';
import { questionDescriptions, questionVerbs } from './question-verbs';

/** An open page/block reference, a type query, `::` field name, or the manual Add type picker. */
export interface Completion { from: number; to: number; query: string; offered?: boolean; types?: boolean; blocks?: boolean; quote?: boolean; fields?: boolean; manual?: { blockId: string; anchor: HTMLElement }; relationTarget?: { parentId: string; kind: RelationKind; anchor: HTMLElement; sourceText?: string } }
/** A slash-menu row: a block verb (`run`) or syntax that replaces the token (`insert`), or both. */
interface SlashItem extends SlashEntry {
  section: string;
  icon: IconName;
  keys?: string;
  when?(block: BlockState | undefined): boolean;
  disabledReason?(id: string): string | undefined;
  secondary?: string;
  insert?(text: string): { text: string; caret: number };
  cardKind?: InsertCardKind;
  relationKind?: RelationKind;
  relationAction?: 'add' | 'change' | 'remove';
  run?(id: string): void;
}
type CompletionRow = { kind: 'block'; block: Block & Partial<Pick<NameCompletion, 'alias'>> } | { kind: 'field'; field: FieldDefinition };
export function createOutlineCompletions(context: Pick<OutlineContext,
  | 'contextDate' | 'editing' | 'textRange' | 'composition' | 'caret'
  | 'editor' | 'doc' | 'capabilities' | 'setCaret' | 'scheduleReport'
  | 'setMessage' | 'disposed' | 'rowAnchor' | 'editAt' | 'restoreFocus' | 'props'
  | 'replaceSelection' | 'fields' | 'definitionsById' | 'definitions' | 'activeRange'
  | 'fieldConversion' | 'commandDefinitions' | 'openPlanning' | 'priorityMenu' | 'openProject'
  | 'investigationItems' | 'markRelation' | 'relationMenu' | 'apply' | 'zoomTo' | 'copy' | 'templateFor' | 'rowFocus' | 'openRelation' | 'openViewEmbed' | 'placeReason' | 'usePlace'
  | 'showNotice'
>, startFilling: (id: string) => void = () => {}) {
  const {
    contextDate, editing, textRange, composition, caret, doc,
    capabilities, setCaret, scheduleReport, setMessage, rowAnchor, editAt, restoreFocus,
    props, replaceSelection, fields, definitionsById, definitions, activeRange,
    fieldConversion, openPlanning, priorityMenu, openProject, investigationItems, apply,
    zoomTo, copy, templateFor,
  } = context;
  const [completion, setCompletion] = createSignal<Completion | null>(null);
  const [completionIndex, setCompletionIndex] = createSignal(0);
  const [quoteBusy, setQuoteBusy] = createSignal(false);
  const [dateCompletion, setDateCompletion] = createSignal<(DateToken & { id: string }) | null>(null);
  const [dateIndex, setDateIndex] = createSignal(0);
  const [tokenDate, setTokenDate] = createSignal<(DateToken & { id: string; text: string; anchor: HTMLElement | DOMRect }) | null>(null);
  const [slashCompletion, setSlashCompletion] = createSignal<(SlashToken & { id: string }) | null>(null);
  const [slashIndex, setSlashIndex] = createSignal(0);
  let completionList: HTMLDivElement | undefined;
  let slashList: HTMLDivElement | undefined;
  /** `@` offers dates; choosing one makes the block a scheduled task (or a deadline after `@by`/`@due`) and removes the token. */
  const dateRows = createMemo<DateSuggestion[]>(() => { const state = dateCompletion(); return state ? dateSuggestions(state.query, contextDate()) : []; });
  const dateError = createMemo(() => { const state = dateCompletion(); return state ? dateQueryError(state.query, contextDate()) : null; });
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
    const prose = token && /\s/.test(token.query.trim()) && !dateQueryError(token.query, contextDate()) && !dateSuggestions(token.query, contextDate()).length;
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
    if (!choice) {
      const anchor = caretRect(state.from) ?? rowAnchor(id);
      if (!anchor) return;
      dismissDate();
      setTokenDate({ ...state, text, anchor });
      return;
    }
    try { applyDateChoice(state, text, choice); }
    catch (reason) { capabilities.failure(id, reason); }
  }
  function applyDateChoice(state: DateToken & { id: string }, text: string, choice: DateSuggestion) {
    const id = state.id;
    if (doc.block(id)?.text !== text) throw new Error('The block changed while choosing a date. Its text was kept.');
    const plan = planDateToken(text, state, choice, doc.block(id)?.task ?? null);
    setDateCompletion(null);
    const result = doc.edit({ kind: 'planTask', id, text: plan.text, value: plan.value }, caret());
    if (!result.ok) throw new Error(result.reason);
    if (context.editor?.id === id) {
      context.editor.sync(plan.text);
      context.editor.view.dispatch({ selection: { anchor: plan.caret } });
    }
    setCaret({ id, offset: plan.caret });
    void doc.flush().catch(reason => capabilities.failure(id, reason));
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
    const removed = removeToken(text, state);
    const next = item.cardKind ? insertCard(removed.text, item.cardKind, removed.caret) : insertion
      ? { text: text.slice(0, state.from) + insertion.text + text.slice(state.to), caret: state.from + insertion.caret }
      : removed;
    setSlashCompletion(null);
    if (item.relationKind || item.relationAction) {
      if (item.relationKind) context.markRelation(id, item.relationKind, next.text);
      else if (item.relationAction === 'remove') context.markRelation(id, null, next.text);
      else context.relationMenu(id, item.relationAction === 'add', next.text);
      return;
    }
    if (!rewriteEditing(id, next)) return;
    if (insertion || item.cardKind) { updateCompletion(next.text, { id, offset: next.caret }, true); updateTriggers(next.text, { id, offset: next.caret }); }
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
  const [valueEditor, setValueEditor] = createSignal<{ id: string; field: FieldDefinition; anchor: HTMLElement } | null>(null);
  /** Controlled values never enter the raw reference editor, including keyboard Enter. */
  function openValueEditor(id: string, anchor?: HTMLElement): boolean {
    const field = definitionsById().get(fieldEntryId(doc.block(doc.outline.parentOf(id))?.text ?? '') ?? '');
    if (!hasValueEditor(field, doc.block(id)?.text ?? '', contextDate())) return false;
    startFilling(id);
    context.rowFocus(id, false, true);
    // Focus tears down the raw editor and may replace its row. Anchor the settled row, not its old button.
    const element = rowAnchor(id)?.querySelector<HTMLElement>('.outline-body') ?? rowAnchor(id) ?? (anchor?.isConnected ? anchor : null);
    if (!element) return false;
    setCompletion(null);
    setValueEditor({ id, field: field!, anchor: element });
    return true;
  }
  /** New template values use exactly the same picker as existing values. */
  function offerValue(id: string, field: FieldDefinition) {
    if (!hasValueEditor(field, '', contextDate())) return;
    requestAnimationFrame(() => {
      if (!context.disposed && !doc.block(id)?.text) openValueEditor(id);
    });
  }
  function dismissValueEditor(id: string) {
    setValueEditor(null);
    const previous = emptyExtraValuePrevious(doc, id, definitionsById());
    if (previous) {
      const result = doc.edit({ kind: 'delete', ids: [id] });
      if (!result.ok) setMessage(result.reason);
      else context.rowFocus(previous);
    }
    restoreFocus();
  }
  function popupKey(event: KeyboardEvent) {
    const state = completion();
    if (!state || !completionTakesKey(event, !state.offered)) return false;
    if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !state.manual && !state.relationTarget && !state.types && !state.fields && context.editor && !textRange() && context.editor.view.state.selection.main.empty) {
      const id = context.editor.id;
      const text = context.editor.view.state.doc.toString();
      const offset = referenceNewlineAt(text, state.from, state.to, !!state.blocks);
      const selectionBefore = activeRange() ?? undefined;
      dismissCompletion();
      replaceSelection('\n', 'text', { anchor: { id, offset }, head: { id, offset } }, selectionBefore);
      return true;
    }
    const count = completionRows().length + (canCreate() ? 1 : 0);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { setCompletionIndex(index => Math.max(0, Math.min(count - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); return true; }
    if (completionPickKey(event)) { void chooseCompletion(); return true; }
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
    const state = completion();
    if (text === '|' && from === to && view.state.selection.main.empty && state && !state.types && !state.fields && !state.blocks && !state.manual && !state.relationTarget && state.to === from) {
      const row = completionRows()[completionIndex()];
      const target = row?.kind === 'field' ? row.field.id : row?.block.id;
      const result = referenceAliasInput(view.state.doc.toString(), state.from, from, target);
      setCompletion(null);
      view.dispatch({ changes: { from: result.from, to: result.to, insert: result.insert }, selection: { anchor: result.caret }, userEvent: 'input.type' });
      return true;
    }
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
    if (state && !state.manual && !state.relationTarget && context.editor) dismissedCompletion = { id: context.editor.id, from: state.from, query: state.query };
    setCompletion(null);
    if (state?.manual || state?.relationTarget) restoreFocus();
  }
  /**
   * `::` at the start of a block picks a field. Otherwise `[[`
   * completes pages, fields and blocks; a whole-row `((` captures a quote, while inline `((` inserts a live reference.
   */
  function completionAt(text: string, at: Caret): Completion | null {
    if (text.startsWith('::') && at.offset >= 2) {
      const query = text.slice(2, at.offset);
      return /[\\`[\]#:\n]/.test(query) ? null : { from: 0, to: at.offset, query, fields: true };
    }
    const typeToken = typeTokenAt(text, at.offset);
    if (typeToken) return { ...typeToken, types: true };
    const reference = referenceCompletionAt(text, at.offset);
    if (!reference) return null;
    return { ...reference, quote: reference.blocks && isQuoteCompletion(text, reference.from, reference.to) };
  }
  let engaged: CompletionToken | null = null;
  /** `typed` is false when only the caret moved or the text was synced, so the picker is offered but not engaged. */
  function updateCompletion(text: string, at: Caret, typed: boolean) {
    if (completion()?.manual || completion()?.relationTarget) return;
    const next = completionAt(text, at);
    engaged = engagedToken(engaged, next && { id: at.id, from: next.from, query: next.query }, typed);
    if (!next) { setCompletion(null); return; }
    if (dismissedCompletion && dismissedCompletion.id === at.id && dismissedCompletion.from === next.from && dismissedCompletion.query === next.query) return;
    dismissedCompletion = null;
    if (completion()?.query !== next.query) setCompletionIndex(0);
    setCompletion(engaged ? next : { ...next, offered: true });
  }
  // A primitive key: every keystroke sets a fresh completion object, and the same query must not fetch twice.
  const completionKey = createMemo(() => {
    const state = completion();
    if (!state || state.fields) return false;
    return `${state.manual || state.types ? 'types' : state.blocks ? 'blocks' : 'text'}:${state.query}`;
  });
  const [matches] = createResource(completionKey, async key => {
    const mode = key.slice(0, key.indexOf(':'));
    const query = key.slice(key.indexOf(':') + 1);
    if (mode === 'types') return completeTypes(props.notebook, query);
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
    // The block being typed in matches its own saved draft; it is never a useful target.
    const found = (matches.error ? [] : matches()?.rows ?? []).filter(block => block.id !== editing());
    if (state?.manual || state?.types) return found.filter(block => block.kind === 'page').map(block => ({ kind: 'block', block }));
    if (state?.relationTarget) return found.map(block => ({ kind: 'block', block }));
    if (state && !state.blocks && isJournalReference(state.query)) {
      return found.filter(block => block.kind === 'journal' && block.text === state.query.trim()).map(block => ({ kind: 'block', block }));
    }
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
  /** An offered picker highlights no row, since Enter leaves it to the editor. */
  const pickable = (index: number) => !completion()?.offered && completionIndex() === index;
  /** As in Find or create, a query that names nothing exactly offers creation after the matches. */
  const canCreate = createMemo(() => {
    const state = completion();
    const title = state?.query.trim().toLocaleLowerCase();
    if (!state || !title || state.blocks) return false;
    if (state.fields) return !/[\\`[\]#:]/.test(title) && !definitions().some(field => field.name.toLocaleLowerCase() === title);
    if (matches.error) return false;
    if (state.manual || state.types) return !matches.loading && !!matches()?.canCreate;
    if (fields.loading || fields.error) return false;
    if (isJournalReference(state.query)) return false;
    return !completionRows().some(row => (row.kind === 'field' ? row.field.name : row.block.kind === 'block' ? '' : row.block.text).toLocaleLowerCase() === title);
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
    return state.types || state.fields ? { from: state.from, to: state.to } : openReferenceRange(text, state.from, state.to, !!state.blocks);
  }
  let drafted = false;
  createEffect(() => {
    const state = completion();
    if (!context.editor) return;
    if (state && !state.manual && !state.relationTarget) { drafted = true; context.editor.markDraft(completionRange(state, context.editor.view.state.doc.toString())); }
    else if (drafted) { drafted = false; context.editor.markDraft(null); }
  });
  async function insertReference(id: string) {
    const state = completion();
    if (state?.relationTarget) {
      const target = state.relationTarget;
      const result = apply({ kind: 'addRelation', parentId: target.parentId, value: target.kind, targetId: id, sourceText: target.sourceText }, true);
      if (result?.ok) {
        setCompletion(null);
        void doc.flush().catch(reason => capabilities.failure(target.parentId, reason));
      }
      return;
    }
    const source = editing();
    if (!state || !context.editor || !source || quoteBusy()) return;
    const text = context.editor.view.state.doc.toString();
    const range = completionRange(state, text);
    if (state.quote) {
      setQuoteBusy(true);
      const before = caret();
      // Enter owns this choice now. Closing the picker or leaving insert mode cannot revoke it.
      setCompletion(null);
      const held = props.notebook.open(doc.pageId);
      try {
        const captured = await captureQuoteCompletion(props.notebook, id);
        if (doc.block(source)?.text !== text) throw new Error('The quote row changed before its snapshot arrived.');
        const next = captured.text;
        const result = doc.edit({ kind: 'quote', id: source, value: captured.quote, text: next }, before);
        if (!result.ok) throw new Error(result.reason);
        if (!context.disposed && editing() === source && context.editor?.id === source) {
          context.editor.sync(next);
          context.editor.view.dispatch({ selection: { anchor: next.length } });
          setCaret({ id: source, offset: next.length });
        }
        referenceSpace = null;
        void doc.flush().catch(reason => { if (!context.disposed) capabilities.failure(source, reason); });
        if (!context.disposed) scheduleReport();
      } catch (reason) {
        if (!context.disposed) capabilities.failure(source, reason);
      } finally { held.release(); setQuoteBusy(false); }
      return;
    }
    const next = context.editor.view.state.doc.sliceString(range.to, range.to + 1);
    // A word after the reference, or the end of the block, gets a separating space so typing continues as prose.
    const space = !next || /[\p{L}\p{N}]/u.test(next) ? ' ' : '';
    const inserted = `${completedReference(text, range.from, range.to, id)}${space}`;
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
    if (state.manual) {
      if (matches.loading || matches.error) return;
      const title = row?.kind === 'block' ? row.block.text : canCreate() ? state.query.trim() : null;
      if (title) {
        const result = doc.addType(state.manual.blockId, title);
        if (!result.ok) setMessage(result.reason);
        setCompletion(null);
        restoreFocus();
      }
      return;
    }
    if (matches.loading) { chooseWhenReady = state.query; return; }
    if (state.types) {
      const source = editing();
      const title = row?.kind === 'block' ? row.block.text : canCreate() ? state.query.trim() : null;
      if (!source || !context.editor || !title || matches.error) return;
      const inserted = `${typeChoiceSpelling(state.query, title)} `;
      const selectionBefore = activeRange() ?? undefined;
      setCompletion(null);
      // Text tags and Add type share the notebook's type-page derivation, including new page creation.
      replaceSelection(inserted, 'text', { anchor: { id: source, offset: state.from }, head: { id: source, offset: state.to } }, selectionBefore);
      referenceSpace = { id: source, offset: state.from + inserted.length };
      return;
    }
    if (row?.kind === 'field') { await insertReference(row.field.id); return; }
    if (matches.error) return;
    if (row?.kind === 'block') { await insertReference(row.block.id); return; }
    if (canCreate()) {
      try { const id = await props.notebook.createPage(state.query.trim()); await insertReference(id); }
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
    if (state?.relationTarget) return state.relationTarget.anchor.getBoundingClientRect();
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
      { id: 'perspective', title: 'Make perspective', aliases: ['position', 'view'], section: 'Block', icon: 'link', keys: 'Space v', when: block => block?.kind === 'block' && !block.position, disabledReason: id => doc.block(id)?.relation ? 'Remove the relation first.' : undefined, run: id => capabilities.invoke(capabilities.edit(id, { kind: 'position', id, value: true })) },
      { id: 'remove-perspective', title: 'Remove perspective', aliases: ['remove position', 'remove view'], section: 'Block', icon: 'close', keys: 'Space v', when: block => block?.kind === 'block' && !!block.position, run: id => capabilities.invoke(capabilities.edit(id, { kind: 'position', id, value: false })) },
      { id: 'change-holder', title: 'Change holder…', aliases: ['holder', 'attribution'], section: 'Block', icon: 'link', when: block => !!block?.position, run: id => context.openRelation(id, 'holder') },
      { id: 'file-under', title: 'File under…', aliases: ['subject', 'file'], section: 'Block', icon: 'link', when: block => !!block?.position, disabledReason: id => !doc.block(id)?.position?.holder_id ? 'Choose a holder before filing this perspective.' : undefined, run: id => context.openRelation(id, 'subject') },
      { id: 'use-place', title: 'Use place', aliases: ['implicit subject'], section: 'Block', icon: 'close', when: block => !!block?.position, disabledReason: context.placeReason, run: context.usePlace },
      ...(doc.root()?.kind === 'journal' ? [{ id: 'integrate', title: 'Integrate…', aliases: ['move', 'file thought'], section: 'Block', icon: 'link' as const, run: (id: string) => context.openRelation(id, 'integrate') }] : []),
      ...relationKinds.map((kind): SlashItem => ({
        id: `relation-${kind}`, title: `${relationLabels[kind]}…`, aliases: [kind, 'argument', 'relation'], section: 'Argument', icon: 'link',
        disabledReason: id => relationReason(doc.block(id)), relationKind: kind,
      })),
      { id: 'relation-kind', title: 'Change kind', aliases: ['argument kind', 'relation kind'], section: 'Argument', icon: 'link', when: block => !!block?.relation, relationAction: 'change' },
      { id: 'remove-relation', title: 'Remove argument', section: 'Argument', icon: 'close', when: block => !!block?.relation, relationAction: 'remove' },
      { id: 'add-relation', title: 'Add argument…', section: 'Argument', icon: 'plus', when: block => !addRelationReason(block), relationAction: 'add' },
      ...(['question', 'assessment'] as const).map((kind): SlashItem => ({
        id: kind, title: `Make ${kind}`, aliases: [kind], section: 'Question', icon: kind === 'question' ? 'question-open' : 'question-settled', keys: 'Space q',
        secondary: questionDescriptions[`Make ${kind}`],
        disabledReason: id => investigationItems(id).find(item => item.label === `Make ${kind}`)?.disabledReason ?? (kind === 'assessment' && doc.block(id)?.question ? 'Remove the question first.' : doc.block(id)?.[kind] ? `Already a ${kind}.` : undefined),
        run: id => {
          const item = investigationItems(id).find(item => item.label === `Make ${kind}`);
          if (item && !item.disabledReason) item.action?.();
        },
      })),
      { id: 'question-parent', title: 'Set parent question…', secondary: questionDescriptions['Set parent question…'], aliases: ['parent', 'part of', 'branch'], section: 'Question', icon: 'question-open', when: block => !!block?.question, run: id => capabilities.open(id, 'question-parent') },
      { id: 'remove-parent', title: 'Remove parent', secondary: questionDescriptions['Remove parent'], aliases: [], section: 'Question', icon: 'question-open', when: block => !!block?.question?.state.parent, run: id => investigationItems(id).find(item => item.label === 'Remove parent')?.action?.() },
      ...Object.keys(questionVerbs).map((title): SlashItem => ({
        id: title.toLowerCase().replaceAll(' ', '-'), title, aliases: [], section: 'Question', icon: 'question-open', secondary: questionVerbs[title],
        when: block => !!block?.question || !!block?.assessment,
        disabledReason: id => investigationItems(id).find(item => item.label === title)?.disabledReason ?? (!investigationItems(id).some(item => item.label === title) ? 'Select a matching question or assessment.' : undefined),
        run: id => { const item = investigationItems(id).find(item => item.label === title); if (item && !item.disabledReason) item.action?.(); },
      })),
      ...([1, 2, 3] as const).map((level): SlashItem => ({ id: `heading-${level}`, title: `Heading ${level}`, aliases: [`h${level}`], section: 'Text', icon: 'heading', keys: '#'.repeat(level), run: id => apply({ kind: 'heading', id, level }) })),
      { id: 'heading-normal', title: 'Normal text', aliases: ['paragraph'], section: 'Text', icon: 'edit', when: block => !!block?.heading, run: id => apply({ kind: 'heading', id, level: null }) },
      { id: 'reference', title: 'Reference', aliases: ['link', 'page', 'mention'], section: 'Text', icon: 'link', keys: '[[', insert: () => ({ text: '[[', caret: 2 }) },
      { id: 'embed-view', title: 'Embed view', aliases: ['saved view', 'live table'], section: 'Text', icon: 'table', run: id => context.openViewEmbed(id) },
      { id: 'quote', title: 'Quote block', aliases: ['quote', 'frozen'], section: 'Text', icon: 'link', keys: '((', when: block => { const state = slashCompletion(); return !!state && !removeToken(block?.text ?? '', state).text.trim(); }, insert: () => ({ text: '(())', caret: 2 }) },
      { id: 'type', title: 'Type', aliases: ['tag', 'supertag'], section: 'Text', icon: 'tag', keys: '#', insert: () => ({ text: '#', caret: 1 }) },
      { id: 'card', title: 'Card', aliases: ['flashcard'], section: 'Cards', icon: 'right', keys: '>>', cardKind: 'forward' },
      { id: 'reverse-card', title: 'Reverse card', aliases: ['reverse', 'flashcard'], section: 'Cards', icon: 'left', keys: '<<', cardKind: 'reverse' },
      { id: 'reversible-card', title: 'Reversible card', aliases: ['both ways', 'flashcard'], section: 'Cards', icon: 'panes', keys: '<>', cardKind: 'both' },
      { id: 'multiline-card', title: 'Multi-line card', aliases: ['multi', 'multiline', 'flashcard'], section: 'Cards', icon: 'down', keys: '>>>', cardKind: 'multiline' },
      { id: 'list-card', title: 'List card', aliases: ['list', 'flashcard'], section: 'Cards', icon: 'down', keys: '>>1.', cardKind: 'list' },
      { id: 'descriptor-card', title: 'Descriptor card', aliases: ['descriptor', 'attribute', 'flashcard'], section: 'Cards', icon: 'concept', keys: ';;', cardKind: 'descriptor' },
      { id: 'cloze', title: 'Cloze', aliases: ['blank', 'fill in', 'flashcard'], section: 'Cards', icon: 'select', keys: '⌘⇧C', cardKind: 'cloze' },
      { id: 'zoom', title: 'Zoom in', aliases: ['focus'], section: 'Block', icon: 'bullet', keys: '⌘.', run: id => zoomTo(id) },
      { id: 'copy-reference', title: 'Copy reference', section: 'Block', icon: 'copy', run: id => copy(`[[${id}]]`) },
    ];
  }
  /** Typing `[] ` or `[ ] ` at the start of a block makes it a task; on a block that already is one, the prefix just disappears. */
  function taskPrefix(text: string, at: Caret): boolean {
    const prefix = /^\[ ?\] /.exec(text)?.[0];
    if (!prefix || at.offset !== prefix.length || composition()) return false;
    const rest = text.slice(prefix.length);
    const result = doc.block(at.id)?.task ? doc.edit({ kind: 'text', id: at.id, text: rest, caret: 0 }, caret()) : doc.edit({ kind: 'planTask', id: at.id, text: rest, value: newTask() }, caret());
    if (!result.ok) { setMessage(result.reason); return true; }
    queueMicrotask(() => { if (context.editor?.id !== at.id) return; context.editor.sync(rest); context.editor.view.dispatch({ selection: { anchor: 0 } }); });
    setCaret({ id: at.id, offset: 0 });
    void doc.flush().catch(reason => capabilities.failure(at.id, reason));
    return true;
  }
function CompletionPopups(){ return <>
    <Show when={completion()}><Popup anchor={completionAnchor} width={480} class="picker" label={completion()?.relationTarget ? 'Relation target' : completion()?.manual ? 'Add type…' : completion()?.types ? 'Type' : completion()?.fields ? 'Field' : completion()?.quote ? 'Quote block' : completion()?.blocks ? 'Block reference' : 'Reference completion'} role={completion()?.manual || completion()?.relationTarget ? 'dialog' : 'listbox'} onDismiss={dismissCompletion} autofocus={!!(completion()?.manual || completion()?.relationTarget)}>
      <Show when={completion()?.manual || completion()?.relationTarget}><div class="picker-query"><Icon name={completion()?.relationTarget ? 'link' : 'tag'} class="picker-prefix" /><input class="picker-input" aria-label={completion()?.relationTarget ? 'Relation target' : 'Type title'} placeholder={completion()?.relationTarget ? 'Find a target' : 'Type title'} value={completion()?.query ?? ''} onInput={event => { setCompletion(state => state ? { ...state, query: event.currentTarget.value } : null); setCompletionIndex(0); }} onKeyDown={event => { if (!event.isComposing && popupKey(event)) { event.preventDefault(); event.stopPropagation(); } }} /></div></Show>
      <div ref={completionList} class="picker-list" onMouseDown={event => event.preventDefault()}>
        <Show when={completion()?.blocks}><div class="picker-section">{completion()?.quote ? 'Quote block' : 'Block reference'}</div></Show>
        <Show when={quoteBusy()}><p class="empty-state" role="status">Capturing quote…</p></Show>
        <Show when={completionKey() && matches.loading && !completionRows().length && !canCreate()}><p class="empty-state">Searching…</p></Show>
        <Show when={completionKey() && matches.error}><p class="error" role="alert">Couldn't load completion.</p></Show>
        <For each={completionRows()}>{(row, index) => <div role="option" aria-selected={pickable(index())} class="picker-row" classList={{ selected: pickable(index()) }} onClick={() => void chooseCompletion(index())}>
          <Show when={row.kind === 'block' ? row.block : null}>{block => {
            const icon = createPageIcon(props.notebook, block);
            return <><Icon name={icon()} /><span class="picker-text">{block().text ? <BlockText text={block().text} notebook={props.notebook} interactive={false} /> : 'Empty block'}</span><Show when={block().alias}>{alias => <span class="reference-via">via {alias()}</span>}</Show><Show when={block().kind === 'block'}><span class="picker-meta"><BlockBreadcrumb block={block()} notebook={props.notebook} /></span></Show></>;
          }}</Show>
          <Show when={row.kind === 'field' ? row.field : null}>{field => <><Icon name="field" /><span class="picker-text">{field().name}</span><span class="picker-meta">{completion()?.fields ? kindLabels[field().kind] : 'Field'}</span></>}</Show>
        </div>}</For>
        <Show when={canCreate()}><div role="option" aria-selected={pickable(completionRows().length)} class="picker-row" classList={{ selected: pickable(completionRows().length) }} onClick={() => void chooseCompletion(completionRows().length)}><Icon name="plus" /><span class="picker-text">{completion()?.fields ? 'Create field' : completion()?.types ? 'Create type' : 'Create page'} “{completion()?.query.trim()}”</span></div></Show>
        <Show when={!(completionKey() && (matches.loading || matches.error)) && !canCreate() && !completionRows().length}><p class="empty-state">{
          completion()?.fields ? 'Type a field name.' : completion()?.blocks && !completion()?.query.trim() ? 'Type to search blocks.' : 'No matching blocks.'
        }</p></Show>
      </div>
    </Popup></Show>
    <Show keyed when={valueEditor()}>{state => <ValueEditor notebook={props.notebook} anchor={state.anchor} field={definitionsById().get(state.field.id) ?? state.field} text={doc.block(state.id)?.text ?? ''} contextDate={contextDate()}
      owner={(owner => owner ? { id: owner, page: doc.block(owner)?.pageId ?? '' } : undefined)(doc.outline.parentOf(doc.outline.parentOf(state.id)))}
      onDismiss={() => dismissValueEditor(state.id)} onError={setMessage}
      onCreateOption={async text => { const change = await createOptionValue(props.notebook, doc, { field: state.field, ownerId: doc.outline.parentOf(doc.outline.parentOf(state.id)), valueId: state.id }, text); context.showNotice('Option added.', change.undo); }}
      onWrite={async text => { writeFieldValue(doc, { field: state.field, ownerId: doc.outline.parentOf(doc.outline.parentOf(state.id)), valueId: state.id }, text); await doc.flush(); }} />}</Show>
    <Show when={dateCompletion()}><Popup anchor={() => caretRect(dateCompletion()?.from ?? 0)} width={320} class="picker" label={dateCompletion()?.field === 'deadline' ? 'Deadline' : 'Scheduled'} role="listbox" onDismiss={dismissDate}>
      <div class="picker-list" onMouseDown={event => event.preventDefault()}>
        <div class="picker-row" role="presentation"><span class="picker-text">{dateCompletion()?.field === 'deadline' ? 'Deadline' : 'Scheduled'}</span><span class="picker-meta"><kbd>Tab</kbd></span></div>
        <For each={dateRows()}>{(row, index) => <div role="option" aria-selected={dateIndex() === index()} class="picker-row" classList={{ selected: dateIndex() === index() }} onClick={() => chooseDate(index())}>
          <Icon name={dateCompletion()?.field === 'deadline' ? 'warning' : 'calendar'} /><span class="picker-text">{row.label}</span><span class="picker-meta">{row.date}</span>
        </div>}</For>
        <Show when={dateError()} fallback={<Show when={!dateRows().length}><p class="empty-state">No matching date</p></Show>}>{error => <p class="error" role="alert">{error()}</p>}</Show>
        <div role="option" aria-selected={dateIndex() === dateRows().length} class="picker-row" classList={{ selected: dateIndex() === dateRows().length }} onClick={() => chooseDate(dateRows().length)}>
          <Icon name="more" /><span class="picker-text">Pick a date…</span>
        </div>
      </div>
    </Popup></Show>
    <Show keyed when={tokenDate()}>{state => <DatePicker notebook={props.notebook} anchor={state.anchor} label={state.field === 'deadline' ? 'Deadline' : 'Schedule task'} value={doc.block(state.id)?.task?.[state.field] ?? null} initialQuery={state.query} time={null} contextDate={contextDate()}
      onDismiss={() => { setTokenDate(null); if (editing() === state.id) editAt(state.id, caret()?.id === state.id ? caret()!.offset : state.to, true); }}
      onSelect={value => { if (value.date) applyDateChoice(state, state.text, { label: value.date, date: value.date, time: value.time }); }} />}</Show>
    <Show when={slashCompletion()}><Popup anchor={() => caretRect(slashCompletion()?.from ?? 0)} width={320} class="picker" label="Commands" role="listbox" onDismiss={dismissSlash}>
      <div ref={slashList} class="picker-list" onMouseDown={event => event.preventDefault()}>
        <For each={slashRows()}>{(row, index) => <>
          <Show when={index() === 0 || slashRows()[index() - 1]!.section !== row.section}><div class="picker-section">{row.section}</div></Show>
          <div role="option" aria-selected={slashIndex() === index()} aria-disabled={!!row.disabledReason?.(slashCompletion()!.id)} title={row.disabledReason?.(slashCompletion()!.id)} class="picker-row" classList={{ selected: slashIndex() === index() }} onClick={() => chooseSlash(index())}>
            <Icon name={row.icon} /><span class="picker-text">{row.title}<Show when={row.disabledReason?.(slashCompletion()!.id) || row.secondary}>{text => <small class="picker-disabled-reason">{text()}</small>}</Show></span><Show when={row.keys}><span class="picker-meta"><kbd>{row.keys}</kbd></span></Show>
          </div>
        </>}</For>
        <Show when={!slashRows().length}><p class="empty-state">No matching command. Escape keeps the text.</p></Show>
      </div>
    </Popup></Show>
</>; }
  return { setCompletion, setCompletionIndex, offerValue, openValueEditor, closeValueEditor: () => setValueEditor(null), valueEditorId: () => valueEditor()?.id, updateCompletion, updateTriggers, taskPrefix, rewriteEditing, referenceInput, forgetReferenceSpace, slashKey, dateKey, popupKey, CompletionPopups };
}
