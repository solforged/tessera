import { opensBeside } from '../shell/beside';
import { CardSummary } from './CardSummary';
import { For, Show, batch, createEffect, createMemo, createResource, createSignal, lazy, mapArray, on, onCleanup, onMount, untrack, type Setter } from 'solid-js';
import { createVirtualizer, defaultRangeExtractor } from '@tanstack/solid-virtual';
import type { Block, FieldDefinition, PositionQuestion } from '../api/types';
import { api } from '../api/client';
import type { Caret, Edit, EditResult, PageDocument, TextRange } from '../document/contract';
import { mapTextOffset } from '../document/text-patch';
import { depthStops } from '../shell/contract';
import type { Depth, OutlinePaneProps, ViewState } from '../shell/contract';
import { fieldEntryId } from '../table/query';
import { setLinkedCitation } from '../library/highlights';
import { createTemplateCache, typeKeys } from '../fields/templates';
import { TemplateEditor } from '../fields/TemplateEditor';
import { citedSigla } from '../library/sigla';
import { sourceReadingOrder } from '../library/source-order';
import { isCatalogueField } from '../library/details';
import { fieldHide } from '../fields/hide';
import { hasValueEditor } from '../fields/value-options';
import { PersonWorks } from '../library/PersonWorks';
import { NoteAliases, NoteEyebrow, NoteLine } from '../notes/NoteHeader';
import type { OutlineIndex } from '../document/outline-index';
import { JournalHeader } from '../tasks/JournalHeader';
import { spokenJournalDate } from '../tasks/journal-date';
import { JournalResurface } from '../tasks/JournalResurface';
import { NoteRevisit } from '../review/NoteRevisit';
import { ResearchToRevisit } from '../review/ResearchToRevisit';
import { TaskStatusButton } from '../tasks/TaskControls';
import { createProjectSummary } from '../projects/ProjectSummary';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { createVisualViewport } from '../ui/visual-viewport';
import { BlockText } from './BlockText';
import { displayTitle, plainText, tagLabel } from './names';
import { isStableReference, isViewReference, textTokens } from '../document/text-tokens';
import type { Token } from '../document/text-tokens';
import { PaneEditor } from './editor';
import { createOutlineCapabilities, isCapabilityTag } from './capabilities';
import { editingDepth, hiddenFieldEntries, inlineFieldValues, selectionIds, selectionRoots, survivingZoomPath, visibleIds } from './visibility';
import type { DepthFilter, HiddenFieldEntry } from './visibility';
import { CitationChip, SourceHeader } from './SourceHeader';
import { SourceDetails } from './SourceDetails';
import { GLOSS_FIELD, glossEntry } from './gloss';
import { positionFields, positionSource as sharedPositionSource } from './perspectives';
import { Apparatus } from './Apparatus';
import { createFieldEntryConversion, createSourceFieldResets, ensureField, ensureWorkField, isFreshField, settleField } from './source-fields';
import { addTemplateField, setFreshFieldKind } from '../fields/commands';
import { templateOffer } from '../fields/template-offer';
import { createOutlineHints } from './hints';
import { kindNoun } from '../fields/kinds';
import { guessFieldKind } from '../fields/value-reading';
import { sourceFieldName } from './source';
import { createOutlineCompletions } from './completions';
import { headingPrefix } from './completion';
import { createOutlineCommands } from './commands';
import { createOutlineKeyboard } from './keyboard';
import { createOutlineInteractions } from './interactions';
import { createOutlineRows } from './Row';
import { createOutlineDrag } from './drag';
import { createOutlineImages } from './Images';
import { createOutlineRelated } from './Related';
import { Arrivals } from './Arrivals';
import { createFieldSheet } from './field-sheet';
import { fieldBedRows, fieldRole } from '../fields/roles';
import { createCapabilityPopups } from './CapabilityPopups';
import { createRelationActions } from './RelationActions';
import { createViewEmbedActions } from './ViewPicker';
import { createMoveToPage } from './MoveToPage';
import type { MenuState, OutlineContext, RowRange } from './context';
import { PageMergeConfirmation, pageMergeDisabledReason } from './PageMerge';
import { readTagRegistry, TypePill } from './references';
import { noteKindIcon } from '../notes/kinds';
import { foldName, nameMenuItems, resolveName } from './names';
import { titleTargets, typedTitles, withLinkedTitles } from './link-titles';
import { createCitationSources, createCitedSources, hasCitationDetail } from './source-reads';
import { HeldReadings } from './HeldReadings';
import { AssessmentJournal, QuestionBranches, QuestionParent } from './Questions';
import { ReadRegister } from './ReadRegister';
import { isReadingSubject, localPositionCount, readingCounts, readingDisagreementRows, readingRegister, readingSlipRows } from './read-register';
import { typeTokenAt } from './type-completion';
import './outline.css';
import './read-register.css';
const ComparePane = lazy(() => import('../compare/ComparePane').then(module => ({ default: module.ComparePane })));
const RecipeSection = lazy(() => import('../fields/CardTemplatesPane').then(module => ({ default: module.RecipeSection })));

const SpreadPane = lazy(() => import('../notes/SpreadPane').then(module => ({ default: module.SpreadPane })));

const storedFolds = new Map<string, Set<string>>();

export function OutlinePane(props: OutlinePaneProps) {
  return <Show keyed when={props.pageId}>{pageId => <Pane {...props} pageId={pageId} />}</Show>;
}

function Pane(props: OutlinePaneProps) {
  const doc: PageDocument = props.notebook.open(props.pageId);
  const creatingRoot = createMemo(() => doc.root()?.revision === 0);
  const viewport = createVisualViewport();
  const initial = untrack(() => props.view);
  const journalPeriod = untrack(() => props.journalPeriod);
  const reading = () => props.projection === 'read' && !zoom();
  const [readDisclosures, setReadDisclosures] = createSignal(new Set(initial.readDisclosures ?? []));
  const readingSubjects = createMemo(() => {
    doc.outline.version(); doc.archivedVersion();
    const subjects = new Set([props.pageId]);
    for (let at = 0; at < doc.outline.size(); at++) {
      const id = doc.outline.idAt(at), position = doc.block(id)?.position;
      if (position && !doc.isArchived(id) && doc.block(position.subject_id)?.question) subjects.add(position.subject_id);
    }
    return [...subjects].join(',');
  });
  const [positionQuestions] = createResource(() => !creatingRoot() && doc.root()?.kind === 'page' ? [readingSubjects(), props.notebook.changeSequence(), props.notebook.connection() === 'live'] as const : false,
    async ([subjects]) => {
      const results = await Promise.all(subjects.split(',').map(subject => props.notebook.api.positions({ subject })));
      const questions = new Map<string, PositionQuestion>();
      for (const result of results) for (const question of result.questions) {
        const id = question.block.block.id;
        if (!questions.has(id) || question.criterion) questions.set(id, question);
      }
      return { questions: [...questions.values()] };
    });
  const [zoomTarget, setZoom] = createSignal(initial.zoom);
  let previousZoomTarget: string | null = null;
  let previousZoomPath: string[] = [];
  const breadcrumbs = createMemo(() => {
    doc.outline.version();
    const target = zoomTarget();
    if (doc.status() !== 'ready') return target ? [target] : [];
    const path = survivingZoomPath(doc, target, target === previousZoomTarget ? previousZoomPath : []);
    previousZoomTarget = target;
    previousZoomPath = path;
    return path;
  });
  const zoom = createMemo(() => breadcrumbs().at(-1) ?? null);
  // A journal day is titled as its header speaks it, including inside a zoom where the header steps aside; a page's title drops its tag tokens.
  const rootTitle = () => { const root = doc.root(); return root?.kind === 'journal' ? spokenJournalDate(root.text) : root?.kind === 'page' ? displayTitle(root.text, id => props.notebook.lookup(id)) : root?.text; };
  const titleTags = createMemo(() => { const root = doc.root(); return root?.kind === 'page' ? textTokens(root.text).filter(token => token.kind === 'tag') : []; });
  const titleTagKind = (token: Token) => tagRegistry.error ? undefined : tagRegistry()?.kinds.find(kind => kind.tag && (token.id ? kind.type_id === token.id : foldName(kind.name) === foldName(token.value)));
  createEffect(() => { if (doc.status() === 'ready' && zoomTarget() !== zoom()) setZoom(zoom()); });
  const [folds, setFolds] = createSignal(new Set(initial.folds ?? storedFolds.get(`${props.pane}:${props.pageId}`) ?? []));
  const [foldMotion, setFoldMotion] = createSignal<{ id: string; opening: boolean; afterIds: string[]; beforeSize: number }>();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let foldChildren!: HTMLDivElement, foldFollowing!: HTMLDivElement, foldEditor!: HTMLDivElement;
  let foldFrame = 0;
  let foldAnimations: Animation[] = [];
  let settleFold: (() => void) | undefined;
  const [showArchived, setShowArchived] = createSignal(initial.showArchived);
  const [depth, setDepth] = createSignal<Depth>(initial.depth ?? 'full');
  // A parked caret belongs to the source text in which it was recorded, not a later normalized spelling.
  const [rememberedCaret, setRememberedCaret] = createSignal({ at: initial.caret, text: initial.caret ? doc.block(initial.caret.id)?.text : undefined });
  const caret = createMemo(() => {
    const { at, text } = rememberedCaret();
    const current = at ? doc.block(at.id)?.text : undefined;
    return at && text !== undefined && current !== undefined && text !== current
      ? { id: at.id, offset: mapTextOffset(text, current, at.offset) } : at;
  });
  const setCaret: Setter<Caret | null> = value => {
    const at = typeof value === 'function' ? value(caret()) : value;
    setRememberedCaret({ at, text: at ? doc.block(at.id)?.text : undefined });
    return at;
  };
  const [editing, setEditing] = createSignal<string | null>(initial.caret?.id ?? null);
  const [editorFocused, setEditorFocused] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(initial.caret?.id ?? null);
  const [rowRange, setRowRange] = createSignal<RowRange | null>(null);
  const [textRange, setTextRange] = createSignal<TextRange | null>(null);
  const [composition, setComposition] = createSignal(false);
  const [message, setMessage] = createSignal('');
  /** A change with its Undo, or an offer whose action stands in for Undo. */
  const [notice, setNotice] = createSignal<{ label: string; undo?: () => Promise<void>; action?: { label: string; run: () => Promise<void> } } | null>(null);
  const [noticeBusy, setNoticeBusy] = createSignal(false);
  const [noticeHeld, setNoticeHeld] = createSignal(false);
  function showNotice(label: string, undo?: () => Promise<void>, action?: { label: string; run: () => Promise<void> }) {
    setMessage('');
    setNoticeHeld(false);
    setNotice({ label, undo, action });
  }
  createEffect(() => {
    if (!notice() || noticeHeld() || noticeBusy()) return;
    const timer = setTimeout(() => setNotice(null), 10000);
    onCleanup(() => clearTimeout(timer));
  });
  // A newer outline edit returns keyboard history to this document. Until then the notice owns Undo.
  createEffect(on(() => doc.saveState(), state => {
    if (state !== 'saved' && notice()?.undo) setNotice(null);
  }, { defer: true }));
  async function runNoticeAction() {
    const current = notice();
    if (!current?.action || noticeBusy()) return;
    setNoticeBusy(true);
    try { await current.action.run(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); if (notice() === current) setNotice(null); }
    finally { setNoticeBusy(false); restoreFocus(); }
  }
  async function undoNotice() {
    const current = notice();
    if (!current?.undo || noticeBusy()) return;
    setNoticeBusy(true);
    try { await current.undo(); if (notice() === current) setNotice(null); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setNoticeBusy(false); restoreFocus(); }
  }
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [renaming, setRenaming] = createSignal(false);
  const [title, setTitle] = createSignal('');
  const [mergeTarget, setMergeTarget] = createSignal<{ page: Block; from: { id: string; text: string }; anchor: HTMLElement }>();
  const [tagRegistry] = createResource(() => [props.notebook.changeSequence(), props.notebook.connection()] as const, () => readTagRegistry(props.notebook));
  const titleCollision = createMemo(() => {
    const value = title().trim().toLocaleLowerCase();
    return renaming() && value ? props.notebook.roots().find(page => page.id !== props.pageId && page.kind === 'page' && page.text.toLocaleLowerCase() === value) : undefined;
  });
  const [conflicts, setConflicts] = createSignal(new Set<string>());
  const [editedConflicts, setEditedConflicts] = createSignal(new Set<string>());
  const [margin, setMargin] = createSignal(0);
  let scroll!: HTMLDivElement;
  let list!: HTMLDivElement;
  let heading!: HTMLDivElement;
  let titleInput: HTMLInputElement | undefined;
  const hosts = new Map<string, HTMLElement>();
  let editor: PaneEditor | undefined;
  let restoring = true;
  let disposed = false;
  let focusEpoch = 0;
  let focusRequest: { id: string; offset: number; insert: boolean; epoch: number } | null = null;
  let focusRestoresPending = 0;
  let reportingFrame = 0;
  let scrollSettle = 0;
  const [pendingReadAnchor, setPendingReadAnchor] = createSignal<ViewState['scroll']>(null);
  let revealTimer = 0;
  let revealedReading: HTMLElement | null = null;
  let anchorFrame = 0;
  const [scrollAnchor, setScrollAnchor] = createSignal<ViewState['scroll']>(null);
  let scrollReveal: { id: string; epoch: number; caret: boolean } | null = null;
  let scrollingFrame = false;
  let scrollStable = 0;
  let previousScrollHeight = -1;
  let compositionSelection: { range: TextRange; id: string; original: string; from: number; to: number; committed?: string } | null = null;
  let compositionFrame = 0;
  const [createdFields, setCreatedFields] = createSignal<FieldDefinition[]>([]);
  const live = createMemo(() => props.notebook.connection() === 'live');
  const [fields] = createResource(() => [props.notebook.changeSequence(), live()] as const, () => api.fields());
  const definitions = createMemo(() => {
    const result = new Map<string, FieldDefinition>((fields.error ? [] : fields()?.fields ?? []).map(field => [field.id, field]));
    for (const field of createdFields()) if (!result.has(field.id)) result.set(field.id, field);
    return [...result.values()].filter(field => {
      const block = props.notebook.lookup(field.id)();
      return block !== null && !block?.archived;
    });
  }, undefined, {
    // Fields refetch after every committed change; unchanged definitions must not reconfigure the editor or re-scan rows.
    equals: (a, b) => a.length === b.length && a.every((field, index) => { const other = b[index]!; return field.id === other.id && field.revision === other.revision && field.name === other.name && field.kind === other.kind && JSON.stringify(field.options) === JSON.stringify(other.options); }),
  });
  const definitionsById = createMemo(() => new Map(definitions().map(field => [field.id, field])));
  const definitionsByName = createMemo(() => new Map(definitions().map(field => [field.name.toLowerCase(), field])));
  const register = createMemo(() => readingRegister(doc, id => definitionsById().get(id), positionQuestions.error ? [] : positionQuestions()?.questions ?? []), undefined, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const templates = createTemplateCache(() => fields.error ? undefined : fields(), props.notebook.lastChange);
  const glossId = createMemo(() => doc.root()?.kind === 'page' ? glossEntry(doc, id => fieldRole(definitionsById().get(id)) === 'standfirst') : null);
  const depthFilter = createMemo<DepthFilter | undefined>(() => !reading() && doc.root()?.kind === 'page' && depth() !== 'full'
    ? { stop: depth(), gloss: glossId(), position: id => !!doc.block(id)?.position, gist: id => fieldRole(definitionsById().get(fieldEntryId(doc.block(id)?.text ?? '') ?? '')) === 'standfirst' } : undefined);
  const [type] = createResource(
    () => !creatingRoot() && doc.root()?.kind === 'page' ? [props.pageId, props.notebook.changeSequence(), live()] as const : false,
    ([pageId]) => api.type(pageId),
  );
  const [editingNames] = createResource(() => {
    const id = editing();
    const names = id ? [...new Set(textTokens(doc.block(id)?.text ?? '').flatMap(token => token.kind === 'reference' && !isStableReference(token) && !isViewReference(token) ? [token.id!] : []))] : [];
    return names.length ? [names.join('\u0000'), props.notebook.changeSequence()] as const : false;
  }, async ([names]) => new Map(await Promise.all(names.split('\u0000').map(async name => [foldName(name), await resolveName(props.notebook, name)] as const))));
  const sourceResets = createSourceFieldResets({ doc, notebook: props.notebook, definitions: definitionsById, caret, onError: setMessage });
  const hints = createOutlineHints({ notebook: props.notebook, doc, editing: () => editorFocused() ? editing() : null, visible: () => ids(), fieldKnown: id => definitionsById().has(id) });
  const [tagTemplate, setTagTemplate] = createSignal<{ id: string; anchor: HTMLElement }>();
  const [receiptType] = createResource(() => {
    const target = tagTemplate();
    return target ? [target.id, props.notebook.changeSequence(), live()] as const : false;
  }, ([id]) => api.type(id));
  function DiscoveryHints(row: { id: string }) {
    return <For each={hints.forBlock(row.id)}>{hint => <div class="outline-discovery" role="status" onMouseDown={event => event.stopPropagation()}>
      <Show when={hint.kind === 'tag' ? hint.type : undefined} fallback={<span>{hint.kind === 'card' ? 'a card · tag it to put it in a deck' : 'a field · its tag can carry it as a template'}</span>}>{type => <>
        <span>#{type().title} is new</span><span aria-hidden="true">·</span>
        <Button class="notice-undo" aria-haspopup="dialog" aria-expanded={tagTemplate()?.id === type().id} onClick={event => setTagTemplate({ id: type().id, anchor: event.currentTarget.closest<HTMLElement>('.outline-discovery')! })}>Add fields</Button>
        <span aria-hidden="true">·</span><Button class="notice-undo" onClick={event => props.onOpen({ kind: 'page', pageId: type().id }, opensBeside(event))}>Open</Button>
      </>}</Show>
    </div>}</For>;
  }

  const contextDate = () => doc.root()?.kind === 'journal' ? doc.root()!.text : props.notebook.todayDate();
  const rowAnchor = (id: string) => id === props.pageId ? heading ?? null : hosts.get(id)?.closest<HTMLElement>('[data-block-id]') ?? null;
  const readingAnchor = (id: string) => scroll?.querySelector<HTMLElement>(`[data-reading-id="${CSS.escape(id)}"]`) ?? rowAnchor(id);
  const capabilities = createOutlineCapabilities({ doc, notebook: props.notebook, contextDate, caret, anchor: rowAnchor, onOpen: props.onOpen });

  const fieldConversion = createFieldEntryConversion({
    doc, notebook: props.notebook, disposed: () => disposed, composing: composition, caret, focusEpoch: () => focusEpoch,
    known: name => definitionsByName().get(name.toLowerCase()),
    targetKind: id => props.notebook.lookup(id)()?.kind,
    onStart: () => setCompletion(null),
    onField: field => setCreatedFields(previous => previous.some(existing => existing.id === field.id) ? previous : [...previous, field]),
    onCommitted: (id, next, epoch, focus, field) => {
      setMessage('');
      offerTemplateField(id);
      hints.fieldEntry(id);
      setFolds(previous => { const next = new Set(previous); next.delete(id); return next; });
      if (next && focusEpoch === epoch) {
        setSelected(next.id);
        setCaret(next);
        setRowRange(null);
        setTextRange(null);
        setEditing(next.id);
        if (focus && props.active) queueMicrotask(() => { editAt(next.id, next.offset, true, true, false); offerValue(next.id, field); });
      }
      scheduleReport();
    },
    onError: setMessage,
  });
  /** Leaving a block converts `Name::` shorthand and links hand-typed `[[Title]]`; true when a field conversion started. */
  function commitFieldEntry(id: string, focus = true) {
    linkTitles(id);
    settleFreshField(id);
    offerTemplateField(doc.outline.parentOf(id));
    return fieldConversion.shorthand(id, focus);
  }
  /**
   * After a field entry on a typed block gets a value, offers to add the field to the type's template when another
   * member already uses it.
   */
  function offerTemplateField(entryId: string | null | undefined) {
    const fieldId = entryId ? fieldEntryId(doc.block(entryId)?.text ?? '') : null;
    const ownerId = entryId ? doc.outline.parentOf(entryId) : null;
    const owner = ownerId ? doc.block(ownerId) : undefined;
    if (!fieldId || !owner || !doc.outline.children(entryId!).some(id => doc.block(id)?.text.trim())) return;
    void templateOffer(props.notebook, owner, fieldId).then(offer => {
      if (!offer || disposed) return;
      const name = definitionsById().get(fieldId)?.name ?? 'This field';
      // The tag as the owner spells it, else the type's title.
      const typed = textTokens(owner.text).find(token => token.kind === 'tag' && (token.id ? token.id === offer.type.page.id : token.value.trim().toLowerCase() === offer.type.page.text.toLowerCase()));
      const tag = typed ? `#${offer.type.page.text}` : offer.type.page.text;
      showNotice(`${name} is on another ${tag} too.`, undefined, { label: `Add to ${tag}`, run: async () => {
        const change = await addTemplateField(props.notebook, offer.type, fieldId);
        showNotice(`${name} added to ${tag}.`, change.undo);
      } });
    }, () => {});
  }
  /** Leaving the first value of a field `name::` just created gives the field the kind that value suggests. */
  function settleFreshField(id: string) {
    const fieldId = fieldEntryId(doc.block(doc.outline.parentOf(id))?.text ?? '');
    const text = doc.block(id)?.text.trim();
    if (!fieldId || !text || !isFreshField(props.notebook, fieldId)) return;
    settleField(props.notebook, fieldId);
    const kind = guessFieldKind(text, target => props.notebook.lookup(target)()?.kind);
    const name = definitionsById().get(fieldId)?.name ?? 'This field';
    if (kind) void setFreshFieldKind(props.notebook, fieldId, kind).then(change => showNotice(`${name} is now a ${kindNoun(kind)} field.`, change.undo), reason => setMessage(reason instanceof Error ? reason.message : String(reason)));
  }
  /** A hand-typed name links only when one page owns it; ambiguous names wait for a choice. */
  const linking = new Set<string>();
  function linkTitles(id: string) {
    if (pendingReference(id)) return;
    const titles = typedTitles(doc.block(id)?.text ?? '');
    if (!titles.length || linking.has(id)) return;
    linking.add(id);
    void (async () => {
      try {
        const targets = await titleTargets(props.notebook, titles);
        const current = doc.block(id)?.text;
        if (disposed || editing() === id || !current) return;
        const next = withLinkedTitles(current, targets);
        if (next === current) return;
        const result = doc.edit({ kind: 'text', id, text: next }, caret());
        if (!result.ok) setMessage(result.reason);
      } catch (error) {
        if (!disposed) setMessage(error instanceof Error ? error.message : String(error));
      } finally { linking.delete(id); }
    })();
  }

  const [sourceFieldsVisible, setSourceFieldsVisible] = createSignal(initial.sourceFieldsVisible ?? false);
  const [sourceDetailsOpen, setSourceDetailsOpen] = createSignal(false);
  const [sourceColors, setSourceColors] = createSignal<string[]>([]);
  const [sourceGrouped, setSourceGrouped] = createSignal(true);
  const [revealedFields, setRevealedFields] = createSignal<ReadonlySet<string>>(new Set());
  const sourceVisibleIds = createMemo(() => {
    const visible = visibleIds(doc, zoom(), folds(), showArchived(), undefined, depthFilter());
    if (!doc.root()?.source || zoom()) return visible;
    // Field definitions distinguish source metadata from ordinary outline rows; never guess while loading.
    if (!fields.error && !fields()) return [];
    const roots = new Map<string, string>();
    const colors = sourceColors(), showFields = sourceFieldsVisible();
    const shown = visible.filter(id => {
      const parent = doc.outline.parentOf(id), root = parent === props.pageId ? id : roots.get(parent) ?? id;
      roots.set(id, root);
      const block = doc.block(root);
      const name = sourceFieldName(untrack(() => block?.text ?? ''), definitionsById());
      if (name && isCatalogueField(name)) return showFields;
      const citation = block?.citations.find(value => value.source_id === props.pageId);
      return !citation || !colors.length || !!citation.color && colors.includes(citation.color);
    });
    // Authored non-catalogue fields keep their normal outline position; only source-owned groups reorder.
    const ordinary = new Set(shown.filter(id => doc.outline.parentOf(id) === props.pageId && untrack(() => {
      const name = sourceFieldName(doc.block(id)?.text ?? '', definitionsById());
      return !!name && !isCatalogueField(name);
    })));
    if (!ordinary.size) return sourceReadingOrder(doc, shown, definitionsById());
    const groups = new Map<string, string[]>();
    for (const id of shown) {
      const root = roots.get(id)!;
      const group = groups.get(root);
      if (group) group.push(id); else groups.set(root, [id]);
    }
    const ordered = sourceReadingOrder(doc, shown.filter(id => !ordinary.has(roots.get(id)!)), definitionsById());
    const remaining = [...new Set(ordered.map(id => roots.get(id)!))];
    let index = 0;
    return [...groups].flatMap(([root, group]) => ordinary.has(root) ? group : groups.get(remaining[index++]!)!);
  });
  const [aliasesVisible, setAliasesVisible] = createSignal(false);
  const hideCandidates = mapArray(createMemo(() => {
    const visible = sourceVisibleIds(), known = definitionsById();
    return untrack(() => visible.filter(id => known.has(fieldEntryId(doc.block(id)?.text ?? '') ?? '')));
  }), id => createMemo((): HiddenFieldEntry => {
    const definition = definitionsById().get(fieldEntryId(doc.block(id)?.text ?? '') ?? '');
    let hide = fieldHide(definition);
    // A required field stays in view while it has no value, whatever its Hide setting.
    const owner = doc.block(doc.outline.parentOf(id));
    if (hide !== 'never' && definition && owner && templates.requiredFor(typeKeys(owner.text, owner.manual_types)).has(definition.id)) hide = 'never';
    doc.archivedVersion();
    const values = doc.outline.children(id).filter(value => !doc.isArchived(value));
    if (!zoom() && !aliasesVisible() && doc.root()?.kind === 'page' && !doc.root()?.source && doc.root()?.text.toLowerCase() !== 'fields'
      && doc.outline.parentOf(id) === props.pageId && foldName(definition?.name ?? '') === 'aliases'
      && values.some(value => doc.block(value)?.text.trim())) hide = 'always';
    const descendants: string[] = [];
    const start = doc.outline.indexOf(id);
    for (let index = start + 1, end = doc.outline.subtreeEnd(start); index < end; index++) descendants.push(doc.outline.idAt(index));
    return { id, hide, values: values.map(id => ({ id, blank: hide === 'when_empty' ? !doc.block(id)?.text.trim() : false })), descendants };
  }, undefined, { equals: (a, b) => a.hide === b.hide && a.values.length === b.values.length && a.values.every((value, index) => value.id === b.values[index]!.id && value.blank === b.values[index]!.blank) && a.descendants.length === b.descendants.length && a.descendants.every((id, index) => id === b.descendants[index]) }));
  // Aliases moved into the header's ALSO line are shown there, not hidden.
  const inHeader = (entry: HiddenFieldEntry) => {
    const definition = definitionsById().get(fieldEntryId(doc.block(entry.id)?.text ?? '') ?? '');
    return entry.hide === 'always' && fieldHide(definition) !== 'always' && foldName(definition?.name ?? '') === 'aliases';
  };
  const hiddenCounts = createMemo(() => {
    const counts = new Map<string, number>();
    const hidden = hiddenFieldEntries(hideCandidates().map(value => value()).filter(entry => !inHeader(entry)), new Set(), false);
    for (const id of hidden) {
      const owner = doc.outline.parentOf(id);
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    return counts;
  });
  const hiddenEntries = createMemo(() => {
    const retained = new Set([editing(), selected()].filter((id): id is string => !!id));
    const rows = sourceVisibleIds(), range = rowRange(), text = textRange();
    if (range) for (const id of selectionIds(rows, { anchor: { id: range.anchor, offset: 0 }, head: { id: range.head, offset: 0 } })) retained.add(id);
    if (text) for (const id of selectionIds(rows, text)) retained.add(id);
    const revealed = revealedFields();
    return hiddenFieldEntries(hideCandidates().map(value => value()).filter(entry => !revealed.has(doc.outline.parentOf(entry.id))), retained, false);
  }, undefined, { equals: (a, b) => a.size === b.size && [...a].every(id => b.has(id)) });
  const unfoldedIds = createMemo(() => {
    const hidden = hiddenEntries(), visible = sourceVisibleIds();
    if (!hidden.size) return visible;
    const omitted = new Set(hidden);
    return visible.filter(id => {
      if (omitted.has(doc.outline.parentOf(id))) omitted.add(id);
      return !omitted.has(id);
    });
  });
  const unfoldedSet = createMemo(() => new Set(unfoldedIds()));
  // Only field entries can fold their values inline. Field entries come from structural edits (shorthand
  // conversion inserts the value), which rebuild this list; reading text untracked keeps typing out of it.
  const fieldEntries = createMemo(() => {
    const visible = unfoldedIds(); const definitions = definitionsById();
    return definitions.size ? untrack(() => visible.filter(id => definitions.has(fieldEntryId(doc.block(id)?.text ?? '') ?? ''))) : [];
  });
  // Per-entry memos keep ordinary typing from rebuilding the page's visible list.
  const fieldCandidates = mapArray(fieldEntries, id => ({ id, values: createMemo(() => inlineFieldValues(doc, id, definitionsById()), undefined, { equals: (a, b) => a === b || !!a && !!b && a.length === b.length && a.every((value, index) => value === b[index]) }) }));
  const inlineFields = createMemo(() => {
    const visible = unfoldedSet();
    const retained = new Set([editing(), selected(), rowRange()?.anchor, rowRange()?.head, textRange()?.anchor.id, textRange()?.head.id]);
    const result = new Set<string>();
    for (const candidate of fieldCandidates()) {
      const values = candidate.values();
      // Hidden archived values do not keep the rest from lining up; an entry whose values are all hidden shows as empty.
      if (values?.some(value => visible.has(value)) && values.every(value => visible.has(value) || doc.isArchived(value)) && !retained.has(candidate.id)) result.add(candidate.id);
    }
    return result;
  }, undefined, { equals: (a, b) => a.size === b.size && [...a].every(id => b.has(id)) });
  // Read lines inline field values up with their label as Outline does, so their entry rows drop out.
  const readView = createMemo(() => {
    const view = register(), inline = inlineFields();
    return inline.size ? { ...view, opening: view.opening.filter(id => !inline.has(id)), remaining: view.remaining.filter(id => !inline.has(id)) } : view;
  });
  // Inline entries only drop out of the unfolded list, so selection changes never re-walk the outline.
  const ids = createMemo(() => {
    if (reading()) {
      const view = readView();
      return [...view.opening, ...(view.sectionId ? [view.sectionId] : []), ...view.slips.flatMap(slip => readingSlipRows(doc, slip, readDisclosures())), ...view.disagreements.flatMap(group => readingDisagreementRows(doc, group, readDisclosures())), ...view.remaining];
    }
    const inline = inlineFields(), visible = unfoldedIds();
    return fieldBedRows(doc, inline.size ? visible.filter(id => !inline.has(id)) : visible, definitionsById(), zoom() ?? props.pageId);
  });
  const indices = createMemo(() => new Map(ids().map((id, index) => [id, index])));
  const baseDepth = createMemo(() => zoom() ? doc.outline.depth(zoom()!) : 0);
  const positionSource = (id: string) => sharedPositionSource(doc, id, fieldId => definitionsById().get(fieldId)?.name);
  const localPositions = createMemo(() => localPositionCount(doc));
  const positionZoom = createMemo(() => { const id = zoom(); return id && doc.block(id)?.position ? id : null; });
  const dossierFields = createMemo(() => positionZoom() ? positionFields(doc, positionZoom()!, id => definitionsById().get(id)?.name) : []);
  const [branches] = createResource(() => !creatingRoot() && doc.root()?.question ? [props.pageId, props.notebook.changeSequence()] as const : false,
    ([parent]) => props.notebook.api.questions({ parent }));
  // Sources cited or named by positions on this page, in order of first appearance, give the sigla shown in
  // the margin. A source page's own highlights need no mark.
  const referenceSources = createCitationSources(props.notebook, () => {
    const texts: string[] = [];
    (doc.outline as OutlineIndex).each(0, doc.outline.size(), row => { const text = doc.block(row.id)?.text; if (text) texts.push(text); });
    return texts;
  });
  const citedSources = createMemo(() => {
    const seen: string[] = [];
    const add = (id: string | null | undefined) => { if (id && id !== props.pageId && !seen.includes(id)) seen.push(id); };
    (doc.outline as OutlineIndex).each(0, doc.outline.size(), row => {
      const block = doc.block(row.id);
      if (block?.position) add(positionSource(row.id));
      for (const citation of block?.citations ?? []) add(citation.source_id);
      for (const token of textTokens(block?.text ?? '')) if (hasCitationDetail(token) && referenceSources()?.has(token.id!)) add(token.id!);
    });
    return seen;
  }, undefined, { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) });
  const siglumRecords = createCitedSources(props.notebook, citedSources);
  const sigla = createMemo(() => citedSigla(siglumRecords()));
  /** Each distinct source on the page once, for the apparatus key. */
  const siglumSources = createMemo(() => [...new Set(siglumRecords().flatMap(row => row.source ? [row.source.block_id] : []))]);
  const [sourceHighlights] = createResource(() => !creatingRoot() && doc.root()?.source && !zoom() ? [props.pageId, props.notebook.changeSequence(), live()] as const : false,
    ([source_id]) => props.notebook.api.highlights({ source_id, limit: 100000 }));
  const [sourceHeaderReady, setSourceHeaderReady] = createSignal(false);
  const sourceApparatusReady = () => sourceHeaderReady() && !!(fields.error || fields.latest);
  // Top-level notes reveal their kinds and aliases with the title and opening rows.
  const isNote = () => !zoom() && doc.root()?.kind === 'page' && !doc.root()?.source && doc.root()?.text.toLowerCase() !== 'fields';
  const [noteKinds] = createResource(() => !creatingRoot() && isNote() ? [props.pageId, props.notebook.changeSequence(), live()] as const : false,
    ([id]) => api.noteKinds(id));
  createEffect(() => { if (isNote()) props.onNoteKinds?.(noteKinds.error ? undefined : noteKinds.latest); });
  // Mount the designed structure for measurement, but reveal it and its portaled dock together.
  // Keep settled resources visible during background refreshes, and paint nothing before the first load:
  // the title's "Loading…" placeholder otherwise flashes for a frame on every page open.
  // Once revealed, reconnecting metadata cannot hide a cached editable page.
  // An explicit editing destination already has local text. Catalog metadata must not hide its live caret.
  const [pageRevealed, setPageRevealed] = createSignal(false);
  const pageReady = () => pageRevealed() || doc.status() !== 'loading' && (creatingRoot() || props.notebook.connection() === 'offline'
    || !!(initial.edit && zoom() && initial.caret && doc.block(initial.caret.id))
    || (!doc.root()?.source || sourceApparatusReady() && (!!zoom() || !!(sourceHighlights.error || sourceHighlights())))
      && (!isNote() || !!(fields.error || fields.latest) && !!(noteKinds.error || noteKinds.latest)));
  createEffect(() => { if (pageReady()) setPageRevealed(true); });
  const filedElsewhere = createMemo(() => (sourceHighlights.error ? [] : sourceHighlights()?.rows ?? []).filter(row => row.block.page.id !== props.pageId && (!sourceColors().length || !!row.color && sourceColors().includes(row.color)))
    .sort((a, b) => a.citation.ordinal - b.citation.ordinal || a.citation.start.offset - b.citation.start.offset));
  const sourceDetails = createMemo(() => {
    const fields = new Map<string, string>();
    // The first highlight under each chapter of the contents, in reading order, carries that chapter's title.
    const chapters = new Map<string, string>();
    if (!doc.root()?.source || zoom()) return { fields, chapters };
    const counts = new Map<string, number>();
    for (const row of sourceHighlights.error ? [] : sourceHighlights()?.rows ?? []) {
      const title = row.citation.chapter_title;
      if (row.block.page.id === props.pageId && title && (!sourceColors().length || !!row.color && sourceColors().includes(row.color))) counts.set(title, (counts.get(title) ?? 0) + 1);
    }
    let chapter: string | null | undefined;
    for (const id of unfoldedIds().filter(id => doc.outline.parentOf(id) === props.pageId)) {
      const block = doc.block(id);
      if (!block || block.archived && !showArchived()) continue;
      const name = sourceFieldName(block.text, definitionsById());
      const citation = name ? undefined : block.citations.find(value => value.source_id === props.pageId);
      if (name && isCatalogueField(name)) fields.set(id, name);
      else if (citation) {
        const title = citation.chapter_title ?? null;
        if (sourceGrouped() && title && title !== chapter) chapters.set(id, `${title}${counts.has(title) ? ` · ${counts.get(title)}` : ''}`);
        chapter = title;
      }
    }
    return { fields, chapters };
  });
  const selectedIds = createMemo(() => {
    const range = rowRange();
    if (!range) return selected() ? [selected()!] : [];
    const a = indices().get(range.anchor) ?? -1;
    const b = indices().get(range.head) ?? -1;
    return a < 0 || b < 0 ? [] : ids().slice(Math.min(a, b), Math.max(a, b) + 1);
  });
  const selectedSet = createMemo(() => new Set(selectedIds()));
  // Rows under a selected block move, copy and delete with it, so they read as selected too.
  // Field values hang under hidden field entries, so walk every ancestor, not just the parent.
  const coveredSet = createMemo(() => {
    const covered = new Set<string>();
    if (!rowRange()) return covered;
    const selection = selectedSet();
    for (const id of ids()) {
      if (selection.has(id)) continue;
      // parentOf returns the root for the root itself, so stop at that fixed point.
      for (let child = id, parent = doc.outline.parentOf(id); parent !== child; child = parent, parent = doc.outline.parentOf(parent)) {
        if (selection.has(parent)) { covered.add(id); break; }
      }
    }
    return covered;
  });
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get enabled() { return !reading(); },
    get count() { return reading() ? 0 : ids().length; },
    getScrollElement: () => scroll,
    // One unwrapped line, and constant: TanStack re-estimates every unmeasured row whenever any row resizes.
    estimateSize: () => 28,
    // A sheet moves between value rows in one edit. Sync reads must not reuse either row's old height.
    measureElement: element => element.offsetHeight,
    overscan: 8,
    get scrollMargin() { return margin(); },
    get getItemKey() { const rows = ids(); return (index: number) => rows[index]!; },
    get rangeExtractor() {
      const pinned = [editing(), scrollAnchor()?.id, capabilities.popup()?.id, ...(foldMotion()?.afterIds ?? [])].flatMap(id => id ? indices().get(id) ?? [] : []);
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const result = defaultRangeExtractor(range);
        for (const index of pinned) if (!result.includes(index)) result.push(index);
        return result.sort((a, b) => a - b);
      };
    },
  });
  // Size changes and structural edits share the same anchor/reveal decision, never a second scroll writer.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = item => {
    if (!scrollingFrame) {
      if (anchorFrame) scheduleScroll();
      else if (scroll && item.start < scroll.scrollTop) restoreAnchor(currentAnchor());
    }
    return false;
  };
  const virtualItems = createMemo(() => new Map(virtualizer.getVirtualItems().map(item => [String(item.key), item])));
  const [listHeight, setListHeight] = createSignal(virtualizer.getTotalSize());
  createEffect(() => {
    const height = virtualizer.getTotalSize();
    // Removing a sheet-bearing row must not publish a temporarily shorter sizer and clamp the browser's scrollTop.
    if (!anchorFrame && !scrollingFrame) setListHeight(height);
  });

  function currentAnchor(): ViewState['scroll'] {
    if (!scroll || !list) return null;
    const viewport = scroll.getBoundingClientRect();
    let anchor: ViewState['scroll'] = null;
    const rows = reading() ? scroll.querySelectorAll<HTMLElement>('[data-reading-id], [data-block-id]') : list.querySelectorAll<HTMLElement>('[data-block-id]');
    for (const candidate of rows) {
      const rect = candidate.getBoundingClientRect();
      const offset = rect.top - viewport.top;
      if (rect.bottom > viewport.top + 1 && (!anchor || offset < anchor.offset)) anchor = { id: candidate.dataset.readingId ?? candidate.dataset.blockId!, offset };
    }
    return anchor;
  }
  function report() {
    if (restoring || disposed || props.projection === 'compare' || reading() && pendingReadAnchor()) return;
    props.onViewChange({ ...props.view, reveal: undefined, zoom: zoom(), folds: [...folds()], showArchived: showArchived(), depth: depth(), sourceFieldsVisible: sourceFieldsVisible(), readDisclosures: [...readDisclosures()], caret: caret(), scroll: currentAnchor() });
  }
  function scheduleReport() {
    cancelAnimationFrame(reportingFrame);
    reportingFrame = requestAnimationFrame(report);
  }
  /** Measuring the scroll anchor forces layout, so a scroll reports once it settles rather than every frame. */
  const [sectionName, setSectionName] = createSignal('');
  // The section line sits over the scroller's top space, so the current section is the one below it.
  let navigator: HTMLDivElement | undefined;
  const [longPage, setLongPage] = createSignal(false);
  const [scrolledAway, setScrolledAway] = createSignal(false);
  function scrolled() {
    if (scroll && list) {
      setLongPage(scroll.scrollHeight > scroll.clientHeight);
      setScrolledAway(scroll.scrollTop > 0);
      const top = scroll.getBoundingClientRect().top + (navigator?.offsetHeight ?? 0);
      const rows = [...list.querySelectorAll<HTMLElement>('[data-block-id]')].map(row => ({ row, rect: row.getBoundingClientRect() })).filter(({ rect }) => rect.top <= top);
      const row = rows.find(({ rect }) => rect.bottom > top)?.row ?? rows.sort((a, b) => b.rect.top - a.rect.top)[0]?.row;
      let id = row?.dataset.blockId;
      let holder: string | undefined, section: string | undefined;
      while (id && id !== props.pageId) {
        const block = doc.block(id);
        if (block?.position) holder = block.position.holder_id ? props.notebook.lookup(block.position.holder_id)()?.text : 'Unattributed';
        if (block?.heading && doc.outline.parentOf(id) === props.pageId) section = plainText(block.text, target => props.notebook.lookup(target));
        id = block?.parentId ?? undefined;
      }
      setSectionName([section ?? (holder ? 'Perspectives' : 'Opening'), holder].filter(Boolean).join(' · '));
    }
    clearTimeout(scrollSettle);
    scrollSettle = window.setTimeout(scheduleReport, 150);
  }
  function scheduleScroll() {
    if (disposed) return;
    scrollStable = 0;
    if (!anchorFrame) anchorFrame = requestAnimationFrame(settleScroll);
  }
  function cancelScroll() {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = 0;
    setScrollAnchor(null);
    scrollReveal = null;
    previousScrollHeight = -1;
    setListHeight(virtualizer.getTotalSize());
  }
  function measureRows() {
    scrollingFrame = true;
    // Refresh both sides of a sheet transfer before publishing their combined list height.
    batch(() => {
      for (const row of list.querySelectorAll<HTMLDivElement>('[data-index]')) {
        virtualizer.resizeItem(Number(row.dataset.index), row.offsetHeight);
      }
    });
    setListHeight(virtualizer.getTotalSize());
    scrollingFrame = false;
  }
  function settleScroll() {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = 0;
    if (disposed) return;
    const before = scroll.scrollTop;
    measureRows();
    const bounds = scroll.getBoundingClientRect();
    const anchor = scrollAnchor();
    const row = anchor ? reading() ? readingAnchor(anchor.id) : rowAnchor(anchor.id) : null;
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    let offset = Math.max(0, Math.min(maximum, before + (row && anchor ? row.getBoundingClientRect().top - bounds.top - anchor.offset : 0)));
    const request = scrollReveal;
    const valid = request && props.active && focusEpoch === request.epoch && (request.caret ? editing() : selected()) === request.id;
    const target = valid ? request.caret
      ? editor?.id === request.id && hosts.get(request.id)?.contains(editor.view.dom) ? editor.view.coordsAtPos(editor.view.state.selection.main.head) : null
      : rowAnchor(request.id)?.getBoundingClientRect() : null;
    if (target) {
      // Test the caret against the viewport it would have after anchoring, then make only one scroll write.
      const shift = offset - before;
      if (target.top - shift < bounds.top) offset += target.top - shift - bounds.top;
      else if (target.bottom - shift > bounds.bottom) offset += Math.min(target.bottom - shift - bounds.bottom, target.top - shift - bounds.top);
      offset = Math.max(0, Math.min(maximum, offset));
    }
    if (Math.abs(offset - before) > .5) scroll.scrollTop = offset;
    // Reveal wins. Later measurements retain this resulting position, not the pre-reveal anchor offset.
    if (row && anchor) {
      const position = row.getBoundingClientRect().top - bounds.top;
      if (Math.abs(position - anchor.offset) > .5) setScrollAnchor({ id: anchor.id, offset: position });
    }
    scrollStable = scroll.scrollTop === before && scroll.scrollHeight === previousScrollHeight && (!valid || target) ? scrollStable + 1 : 0;
    previousScrollHeight = scroll.scrollHeight;
    if (scrollStable < 2) anchorFrame = requestAnimationFrame(settleScroll);
    else { cancelScroll(); scheduleReport(); }
  }
  createEffect(on(viewport, () => {
    const id = editing();
    if (!id || !props.active || !editor?.view.hasFocus) return;
    scrollReveal = { id, epoch: focusEpoch, caret: true };
    scheduleScroll();
  }, { defer: true }));
  function restoreAnchor(anchor: ViewState['scroll']) {
    if (!anchor || disposed || !indices().has(anchor.id) && !(reading() && readingAnchor(anchor.id))) return;
    setScrollAnchor({ ...anchor });
    scheduleScroll();
  }
  function restoreInitialAnchor() {
    if (reading()) setPendingReadAnchor(initial.scroll);
    else restoreAnchor(initial.scroll);
  }
  function highlightReading(id: string) {
    clearTimeout(revealTimer);
    revealedReading?.classList.remove('reading-reveal');
    revealedReading = readingAnchor(id);
    revealedReading?.classList.add('reading-reveal');
    revealTimer = window.setTimeout(() => {
      revealedReading?.classList.remove('reading-reveal');
      revealedReading = null;
    }, 1500);
  }
  function anchored(change: () => void) {
    if (!scrollAnchor()) setScrollAnchor(currentAnchor());
    scheduleScroll();
    change();
  }
  function measure(label: 'typing' | 'structural', change: () => void) {
    const start = performance.now();
    change();
    const handler = performance.now() - start;
    document.dispatchEvent(new CustomEvent('outline-handler', { detail: { kind: label, handler, start } }));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.dispatchEvent(new CustomEvent('outline-latency', { detail: { kind: label, handler, start, frame: performance.now() - start } }));
    }));
  }
  function attach(id: string, host: HTMLElement) {
    hosts.set(id, host);
    if (editing() === id) queueMicrotask(() => mountEditor(id));
  }
  function mountEditor(id: string) {
    const host = hosts.get(id);
    const block = doc.block(id);
    if (disposed || !host || !block || !editor || editing() !== id) return;
    const request = focusRequest?.id === id && focusRequest.epoch === focusEpoch ? focusRequest : null;
    if (focusRequest?.id === id) focusRequest = null;
    const same = editor.id === id;
    if (!request && same && host.contains(editor.view.dom)) { editor.sync(block.text); followText(id); return; }
    const offset = request?.offset ?? (caret()?.id === id ? caret()!.offset : 0);
    const popupFocused = document.activeElement?.closest('[role="dialog"], [role="menu"], [role="listbox"]');
    editor.mount(host, id, block.text, offset, request?.insert ?? !props.vim, !!request && props.active && !popupFocused && !renaming());
    if (same) followText(id);
    // Publishing the inserted row's height and revealing its caret must finish before the same paint.
    if (anchorFrame) settleScroll();
    else if (!reading()) virtualizer.measureElement(host.closest<HTMLDivElement>('[data-index]')!);
  }
  /**
   * An edit applied through the document (Backspace over a pair or a reference, a chosen completion) reaches
   * the editor without its update hooks, so the pickers follow the new text here instead of going stale.
   */
  function followText(id: string) {
    if (!editor || editor.id !== id || composition()) return;
    const text = editor.view.state.doc.toString();
    const at = { id, offset: editor.view.state.selection.main.head };
    updateCompletion(text, at, false);
    updateTriggers(text, at);
  }
  /** Structural commands reveal folded destinations before restoring the caret. */
  function revealRow(id: string) {
    if (!doc.block(id)) return;
    if (reading()) {
      const slip = register().slips.find(slip => slip.passages.includes(id) || slip.facts.some(field => doc.outline.children(field.entryId).includes(id)));
      if (slip) setReadDisclosures(previous => new Set([...previous, `${slip.id}:${slip.passages.includes(id) ? 'prose' : 'facts'}`]));
    }
    // A holder-scoped answer may not belong to the Read projection. Reveal its actual editor, never an unrelated survivor.
    if (reading() && !indices().has(id) && definitionsById().has(fieldEntryId(doc.block(doc.outline.parentOf(id))?.text ?? '') ?? '')) props.onProjection?.('outline');
    // Settle a deferred closing fold before unfolding, so its completion cannot hide the target again.
    finishFoldMotion();
    const ancestors: string[] = [];
    for (let child = id, parent = doc.outline.parentOf(id); parent !== child; child = parent, parent = doc.outline.parentOf(parent)) {
      if (folds().has(parent)) ancestors.push(parent);
    }
    if (ancestors.length) setFolds(previous => { const next = new Set(previous); for (const parent of ancestors) next.delete(parent); return next; });
    setDepth(editingDepth(doc, id, zoom(), folds(), showArchived(), depthFilter()));
  }
  function visibleNeighbor(id: string, before: readonly string[]) {
    const visible = indices();
    if (visible.has(id)) return id;
    const at = before.indexOf(id);
    for (let index = at - 1; index >= 0; index--) if (visible.has(before[index]!)) return before[index]!;
    for (let index = at + 1; index < before.length; index++) if (visible.has(before[index]!)) return before[index]!;
    const current = selected();
    return current && visible.has(current) ? current : ids()[0] ?? null;
  }
  /** Hidden or deleted targets leave ownership on the outline, even when no rows remain. */
  function selectSurvivor(id: string, before: readonly string[]) {
    const next = visibleNeighbor(id, before);
    focusEpoch++;
    focusRequest = null;
    batch(() => {
      setCompletion(null);
      setEditing(null);
      setRowRange(null);
      setTextRange(null);
      setSelected(next);
      setCaret(next ? { id: next, offset: 0 } : null);
    });
    props.onVimMode(props.vim ? 'outline' : null);
    if (props.active) scroll.focus({ preventScroll: true });
    scheduleReport();
  }
  function restoreFocus() {
    if (disposed || !props.active || composition() || renaming()) return;
    const id = editing();
    if (id && indices().has(id) && editor?.id === id && editor.view.dom.isConnected) editor.view.focus();
    else scroll.focus({ preventScroll: true });
  }
  function editAt(id: string, offset = 0, insert = !props.vim, reveal = true, activate = true) {
    if (disposed || composition()) return;
    revealRow(id);
    if (!indices().has(id)) { selectSurvivor(id, ids()); return; }
    if (fieldSheet.start(id)) return;
    const previous = editing();
    if (previous && previous !== id && doc.block(previous) && commitFieldEntry(previous)) return;
    if (previous && previous !== id) pruneEmptyValue(previous);
    if (openValueEditor(id)) return;
    if (activate) props.onActivate();
    offset = Math.max(0, Math.min(offset, doc.block(id)?.text.length ?? 0));
    setSelected(id);
    setRowRange(null);
    setCaret({ id, offset });
    focusRequest = { id, offset, insert, epoch: ++focusEpoch };
    if (reveal) { scrollReveal = { id, epoch: focusEpoch, caret: true }; scheduleScroll(); }
    setEditing(id);
    mountEditor(id);
    if (focusRequest) queueMicrotask(() => mountEditor(id));
    scheduleReport();
  }
  function rowFocus(id: string, extend = false, keepValue = false) {
    if (disposed || composition()) return;
    if (!indices().has(id)) { selectSurvivor(id, ids()); return; }
    const previous = editing();
    if (previous && doc.block(previous) && commitFieldEntry(previous)) return;
    if (previous && !(keepValue && previous === id)) { const replacement = pruneEmptyValue(previous); if (replacement && id === previous) id = replacement; }
    focusEpoch++;
    focusRequest = null;
    props.onActivate();
    setCompletion(null);
    setEditing(null);
    setTextRange(null);
    const anchor = rowRange()?.anchor ?? selected() ?? id;
    setRowRange(extend ? { anchor, head: id } : null);
    setSelected(id);
    if (caret()?.id !== id) setCaret({ id, offset: 0 });
    props.onVimMode(props.vim ? 'outline' : null);
    scroll.focus({ preventScroll: true });
    scrollReveal = { id, epoch: focusEpoch, caret: false };
    scheduleScroll();
    scheduleReport();
  }
  function apply(intent: Edit, keepEditing = editing() !== null): EditResult | undefined {
    if (disposed || composition()) return undefined;
    if (intent.kind === 'text' || intent.kind === 'replaceRange' || intent.kind === 'split' || intent.kind === 'merge' || intent.kind === 'pasteBlocks' || intent.kind === 'pasteRows') hints.typed();
    const rearrange = intent.kind === 'indent' || intent.kind === 'outdent' || intent.kind === 'move' || intent.kind === 'moveTo';
    if (intent.kind === 'indent' || intent.kind === 'outdent' || intent.kind === 'move') intent = { ...intent, zoomRoot: zoom() };
    const before = ids();
    const previousCaret = caret();
    const selection = rowRange() ?? (selected() && !editing() ? { anchor: selected()!, head: selected()! } : undefined);
    const epoch = focusEpoch;
    let result: EditResult | undefined;
    focusRestoresPending++;
    measure('structural', () => anchored(() => { result = doc.edit(intent, previousCaret ? { ...previousCaret, selection } : null); }));
    if (!result || !result.ok) { focusRestoresPending--; setMessage(result && !result.ok ? result.reason : 'The edit could not be applied.'); return result; }
    setMessage('');
    if (reading() && (rearrange || ['split', 'insert', 'merge', 'pasteBlocks', 'pasteRows'].includes(intent.kind) || intent.kind === 'replaceRange' && intent.mode !== 'text')) props.onProjection?.('outline');
    setTextRange(null);
    if (!rearrange) setRowRange(null);
    const next = result.caret;
    if (next && keepEditing) revealRow(next.id);
    if (next) queueMicrotask(() => {
      try {
        if (disposed || !props.active || focusEpoch !== epoch) return;
        if (!indices().has(next.id)) selectSurvivor(next.id, before);
        else if (keepEditing) editAt(next.id, next.offset, true, true, false);
        else if (rearrange) scroll.focus({ preventScroll: true });
        else rowFocus(next.id);
      } finally { focusRestoresPending--; }
    });
    else {
      focusRestoresPending--;
      if (selected() && !indices().has(selected()!)) selectSurvivor(selected()!, before);
    }
    scheduleReport();
    return result;
  }
  function roots() { return selectionRoots(doc, selectedIds()); }
  function restoreSelection(range: TextRange) {
    if (!editor || editor.id !== range.head.id) return;
    const anchor = range.anchor.id === range.head.id ? range.anchor.offset
      : doc.outline.indexOf(range.anchor.id) < doc.outline.indexOf(range.head.id) ? 0 : editor.view.state.doc.length;
    setTextRange(range.anchor.id === range.head.id ? null : range);
    editor.view.dispatch({ selection: { anchor, head: range.head.offset } });
  }
  function undo(redo = false) {
    if (disposed || composition()) return;
    if (!redo && notice()?.undo) {
      void undoNotice();
      return;
    }
    const before = ids();
    focusRestoresPending++;
    const result = redo ? doc.redo() : doc.undo();
    if (!result) focusRestoresPending--;
    if (result) {
      revealRow(result.selection?.anchor ?? result.range?.anchor.id ?? result.id);
      revealRow(result.selection?.head ?? result.range?.head.id ?? result.id);
    }
    const epoch = focusEpoch;
    setMessage(doc.historyMessage());
    setTextRange(null);
    setRowRange(null);
    if (result) queueMicrotask(() => {
      try {
        if (disposed || !props.active || focusEpoch !== epoch) return;
        const target = result.range?.head ?? result;
        if (result.selection) {
          const anchor = result.selection.anchor, head = result.selection.head;
          if (!indices().has(anchor) || !indices().has(head)) { selectSurvivor(head, before); return; }
          focusEpoch++;
          focusRequest = null;
          batch(() => {
            setCompletion(null);
            setEditing(null);
            setSelected(head);
            setCaret({ id: head, offset: result.offset });
            setRowRange(anchor === head ? null : { anchor, head });
          });
          props.onVimMode(props.vim ? 'outline' : null);
          scroll.focus({ preventScroll: true });
          scheduleReport();
        } else if (!indices().has(target.id)) selectSurvivor(target.id, before);
        else if (hasValueEditor(definitionsById().get(fieldEntryId(doc.block(doc.outline.parentOf(target.id))?.text ?? '') ?? ''), doc.block(target.id)?.text ?? '', contextDate())) {
          closeValueEditor();
          rowFocus(target.id);
          setCaret({ id: target.id, offset: target.offset });
        } else {
          editAt(target.id, target.offset, !props.vim, true, false);
          if (result.range) queueMicrotask(() => { if (!disposed && props.active && editing() === target.id) restoreSelection(result.range!); });
        }
      } finally { focusRestoresPending--; }
    });
  }
  function activeRange(): TextRange | null {
    const across = textRange();
    if (across) return across;
    const id = editing() ?? selected();
    if (!id || !doc.block(id)) return null;
    if (editing() === id && editor?.id === id) {
      const selection = editor.view.state.selection.main;
      return { anchor: { id, offset: selection.anchor }, head: { id, offset: selection.head } };
    }
    const at = { id, offset: caret()?.id === id ? caret()!.offset : 0 };
    return { anchor: at, head: at };
  }
  function replaceSelection(text: string, mode: 'text' | 'paste' | 'split', range = activeRange(), selectionBefore?: TextRange) {
    if (!range) return;
    const visible = selectionIds(ids(), range);
    const parent = doc.outline.parentOf(range.anchor.id);
    const fieldEntry = mode === 'split' && definitionsById().has(fieldEntryId(doc.block(parent)?.text ?? '') ?? '') ? parent : null;
    apply({ kind: 'replaceRange', range, selectionBefore, between: visible.slice(1, -1), text, mode, zoomRoot: zoom(), fieldEntry }, true);
  }
  function deleteTextRange() { if (textRange()) replaceSelection('', 'text'); }
  function finishFoldMotion() {
    cancelAnimationFrame(foldFrame);
    const settle = settleFold;
    settleFold = undefined;
    for (const animation of foldAnimations) animation.cancel();
    foldAnimations = [];
    batch(() => { settle?.(); setFoldMotion(undefined); });
  }
  function fold(id = selected()) {
    if (!id || composition()) return;
    finishFoldMotion();
    const active = editing() ?? selected();
    if (!folds().has(id) && active && active !== id) {
      const at = doc.outline.indexOf(id);
      const child = doc.outline.indexOf(active);
      if (child > at && child < doc.outline.subtreeEnd(at)) rowFocus(id);
    }
    restoreFocus();
    const opening = folds().has(id);
    const change = () => setFolds(previous => { const next = new Set(previous); opening ? next.delete(id) : next.add(id); return next; });
    const style = getComputedStyle(scroll);
    const time = style.getPropertyValue('--motion-ui').trim();
    const duration = parseFloat(time) * (time.endsWith('ms') ? 1 : 1000);
    const parentIndex = indices().get(id);
    if (reducedMotion.matches || !duration || parentIndex === undefined || !hosts.has(id)) {
      anchored(change); report(); scheduleReport();
      return;
    }
    const rootIndex = doc.outline.indexOf(id), subtreeEnd = doc.outline.subtreeEnd(rootIndex);
    const afterIds = [...virtualItems().keys()].filter(key => {
      const at = doc.outline.indexOf(key);
      return (indices().get(key) ?? 0) > parentIndex && (at <= rootIndex || at >= subtreeEnd);
    });
    const state = { id, opening, afterIds, beforeSize: virtualizer.getTotalSize() };
    const anchor = currentAnchor();
    settleFold = () => {
      if (!opening) change();
      restoreAnchor(anchor);
      report(); scheduleReport();
    };
    batch(() => { setFoldMotion(state); if (opening) change(); });
    // Retain only the rendered trailing rows while the newly visible children are measured.
    foldFrame = requestAnimationFrame(() => { foldFrame = requestAnimationFrame(() => {
      if (foldMotion() !== state || disposed) return;
      const parent = virtualItems().get(id);
      const children = foldGroups().children;
      if (!parent || !children.length) { finishFoldMotion(); return; }
      const top = parent.end - margin();
      const next = foldGroups().after[0];
      const bottom = next ? virtualItems().get(next)!.start - margin()
        : Math.max(...children.map(child => virtualItems().get(child)!.end - margin()));
      const height = Math.max(0, bottom - top);
      const size = virtualizer.getTotalSize();
      const clipped = `inset(${top}px 0 ${Math.max(0, size - top)}px 0)`;
      const revealed = `inset(${top}px 0 ${Math.max(0, size - top - height)}px 0)`;
      const shift = opening ? size - state.beforeSize : height;
      const timing: KeyframeAnimationOptions = { duration, easing: style.getPropertyValue('--motion-ease').trim(), fill: 'both' };
      const following = opening ? [{ transform: `translateY(${-shift}px)` }, { transform: 'translateY(0)' }]
        : [{ transform: 'translateY(0)' }, { transform: `translateY(${-shift}px)` }];
      foldAnimations = [
        foldChildren.animate(opening ? [{ clipPath: clipped, opacity: 0 }, { clipPath: revealed, opacity: 1 }]
          : [{ clipPath: revealed, opacity: 1 }, { clipPath: clipped, opacity: 0 }], timing),
        foldFollowing.animate(following, timing),
      ];
      // The editor's row stays mounted outside the motion groups; below the subtree its own group moves with them.
      const active = editing();
      if (active && state.afterIds.includes(active)) foldAnimations.push(foldEditor.animate(following, timing));
      // Closing near the end shortens the page, so the browser clamps scrollTop when the rows go. Slide the
      // page down by that clamp during the motion, or the settled rows snap down a frame after it ends.
      const clamp = opening ? 0 : Math.max(0, scroll.scrollTop - Math.max(0, scroll.scrollHeight - shift - scroll.clientHeight));
      if (clamp > 0) for (const child of scroll.children) foldAnimations.push(child.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${clamp}px)` }], timing));
      foldAnimations[0]!.id = 'outline-fold-content';
      foldAnimations[1]!.id = 'outline-fold-following';
      foldAnimations[0]!.onfinish = () => { if (foldMotion() === state) finishFoldMotion(); };
    }); });
  }
  function zoomTo(id: string | null) {
    if (composition()) return;
    finishFoldMotion();
    if (editing() && commitFieldEntry(editing()!)) return;
    const previous = zoom();
    setZoom(id);
    setRowRange(null);
    setTextRange(null);
    setEditing(null);
    setSelected(null);
    setCaret(null);
    scroll.scrollTop = 0;
    const target = previous && indices().has(previous) ? previous : ids()[0];
    if (target) rowFocus(target);
    report();
    scheduleReport();
  }
  function zoomOut() {
    const id = zoom();
    if (id) zoomTo(doc.outline.parentOf(id) === props.pageId ? null : doc.outline.parentOf(id));
  }
  /** Moves the depth dial. Rows that leave the list stop being edited or selected; the rest keep their place. */
  function setStop(stop: Depth) {
    if (composition() || depthReason() || stop === depth()) return;
    if (editing() && commitFieldEntry(editing()!)) return;
    anchored(() => setDepth(stop));
    const visible = indices();
    if (editing() && !visible.has(editing()!)) setEditing(null);
    if (selected() && !visible.has(selected()!)) { setSelected(null); setCaret(null); }
    setRowRange(null);
    setTextRange(null);
    report();
    scheduleReport();
  }
  const depthReason = () => doc.root()?.kind !== 'page' ? 'Only titled atoms have depth.' : props.projection && props.projection !== 'outline' ? 'Choose Outline to change depth.' : zoom() ? 'Zoom out to change depth.' : undefined;
  const stepDepth = (delta: 1 | -1) => { const next = depthStops[depthStops.indexOf(depth()) + delta]; if (next) setStop(next); };
  const depthTitles: Record<Depth, string> = { gloss: 'Show the gloss only', opening: 'Show the opening', perspectives: 'Show perspectives', full: 'Show the full atom' };
  /** Edits the gloss, adding the entry as the page's first block when there is none. */
  function addGloss() {
    const existing = glossId();
    if (existing) {
      if (zoom()) zoomTo(null);
      const value = doc.outline.children(existing)[0];
      if (value) editAt(value, doc.block(value)?.text.length ?? 0, true);
      return;
    }
    const before = caret();
    const epoch = focusEpoch;
    void (async () => {
      try {
        const field = definitionsByName().get(GLOSS_FIELD.toLowerCase()) ?? await ensureField(props.notebook, GLOSS_FIELD, 'text', 'standfirst');
        if (disposed) return;
        setCreatedFields(previous => previous.some(existing => existing.id === field.id) ? previous : [...previous, field]);
        const result = doc.edit({ kind: 'addFieldEntries', parentId: props.pageId, after: null, entries: [{ fieldId: field.id, value: '' }] }, before);
        if (!result.ok) { setMessage(result.reason); return; }
        if (result.caret && props.active && focusEpoch === epoch) editAt(result.caret.id, result.caret.offset, true, true, false);
      } catch (error) { if (!disposed) setMessage(error instanceof Error ? error.message : String(error)); }
    })();
  }
  /** Aliases are ordinary field values; a new one always opens for editing. */
  function addAlias() {
    void (async () => {
      try {
        const field = definitionsByName().get('aliases') ?? await ensureField(props.notebook, 'aliases');
        setCreatedFields(previous => previous.some(existing => existing.id === field.id) ? previous : [...previous, field]);
        if (disposed) return;
        if (zoom()) zoomTo(null);
        if (depth() !== 'full') setStop('full');
        setAliasesVisible(true);
        const entry = doc.outline.children(props.pageId).find(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === field.id);
        if (entry) setFolds(previous => { const next = new Set(previous); next.delete(entry); return next; });
        const result = entry
          ? doc.edit({ kind: 'insert', parentId: entry, after: doc.outline.children(entry).at(-1) ?? null, text: '' }, caret())
          : doc.edit({ kind: 'addFieldEntries', parentId: props.pageId, after: glossId(), entries: [{ fieldId: field.id, value: '' }] }, caret());
        if (!result.ok) { setMessage(result.reason); return; }
        if (result.caret) editAt(result.caret.id, result.caret.offset, true);
      } catch (error) { if (!disposed) setMessage(error instanceof Error ? error.message : String(error)); }
    })();
  }
  function clearSelection() {
    focusEpoch++;
    focusRequest = null;
    setEditing(null);
    setSelected(null);
    setCaret(null);
    setRowRange(null);
    setTextRange(null);
    resetRowKey();
    scheduleReport();
  }

  function rename() {
    if (doc.root()?.kind !== 'page') return;
    setTitle(doc.root()!.text); setRenaming(true); queueMicrotask(() => { titleInput?.focus(); titleInput?.select(); });
  }
  function closeTitle() {
    focusEpoch++;
    focusRequest = null;
    batch(() => {
      setRenaming(false);
      setEditing(null);
      setCompletion(null);
      setTextRange(null);
      setMessage('');
    });
    props.onVimMode(props.vim ? 'outline' : null);
    if (props.active) scroll.focus({ preventScroll: true });
    scheduleReport();
  }
  function commitTitle() {
    const collision = titleCollision();
    if (collision && titleInput) {
      const reason = pageMergeDisabledReason(doc.root(), doc.capabilities(props.pageId));
      if (reason) { setMessage(reason); return; }
      setMessage('');
      setMergeTarget({ page: collision, from: { id: props.pageId, text: doc.root()!.text }, anchor: titleInput });
      return;
    }
    const result = doc.rename(title());
    if (result.ok) closeTitle();
    else { setMessage(result.reason); titleInput?.focus(); }
  }

  function composing(active: boolean, committed?: string) {
    if (active && textRange() && editor) {
      const selection = editor.view.state.selection.main;
      compositionSelection = { range: textRange()!, id: editor.id, original: editor.view.state.doc.toString(), from: selection.from, to: selection.to };
    }
    setComposition(active);
    if (!active && compositionSelection) {
      const snapshot = compositionSelection;
      snapshot.committed = committed;
      cancelAnimationFrame(compositionFrame);
      compositionFrame = requestAnimationFrame(() => {
        if (disposed || compositionSelection !== snapshot || editor?.id !== snapshot.id) return;
        const text = editor.view.state.doc.toString();
        compositionSelection = null;
        if (snapshot.committed || text !== snapshot.original) {
          const suffix = snapshot.original.length - snapshot.to;
          replaceSelection(snapshot.committed || text.slice(snapshot.from, Math.max(snapshot.from, text.length - suffix)), 'text', snapshot.range);
        } else restoreSelection(snapshot.range);
      });
    }
  }


  // Factories share the pane's owner. Keep signals callable and late-mounted state behind getters;
  // forwarding callbacks connect factories without reading another factory before it is initialized.
  const context: OutlineContext = {
    contextDate,
    editing,
    textRange,
    composition,
    caret,
    get editor() { return editor; },
    doc,
    capabilities,
    setCaret,
    scheduleReport,
    setMessage,
    showNotice,
    openMoveToPage: () => openMoveToPage(),
    openRelation: (id, kind, anchor) => openRelation(id, kind, anchor),
    positionReason: id => positionReason(id),
    placeReason: id => placeReason(id),
    usePlace: id => usePlace(id),
    get disposed() { return disposed; },
    rowAnchor,
    editAt,
    restoreFocus,
    props,
    replaceSelection,
    fields,
    definitionsById,
    definitions,
    templateFor: templates.templateFor,
    requiredFor: templates.requiredFor,
    activeRange,
    fieldConversion,
    get commandDefinitions() { return commandDefinitions; },
    fieldMenu: (id, anchor) => fieldMenu(id, anchor),
    pickField: (owner, anchor) => fieldSheet.pick(owner, anchor),
    openViewEmbed: id => openViewEmbed(id),
    openPlanning: (id, kind) => openPlanning(id, kind),
    priorityMenu: (id) => priorityMenu(id),
    openProject: (id) => openProject(id),
    investigationItems: (id, manager) => investigationItems(id, manager),
    markRelation: (id, kind, text) => markRelation(id, kind, text),
    relationMenu: (id, add, text) => relationMenu(id, add, text),
    apply,
    chooseImage: (id, replace) => images.chooseImage(id, replace),
    openImage: id => images.openImage(id),
    editOcclusion: id => images.editOcclusion(id),
    uploadImages: (files, targetId) => images.uploadImages(files, targetId),
    zoomTo,
    copy: (text) => copy(text),
    commitFieldEntry,
    selected,
    setMenu,
    rename,
    addGloss,
    addAlias,
    localPositions,
    depthTitles,
    depthReason,
    setStop,
    depth,
    stepDepth,
    get heading() { return heading; },
    adjacent: (direction, extend) => adjacent(direction, extend),
    horizontal: (direction) => horizontal(direction),
    ids,
    rowFocus,
    split: (view) => split(view),
    roots,
    setRowRange,
    fold,
    zoom,
    zoomOut,
    anchored,
    setShowArchived,
    undo,
    setConflicts,
    indices,
    setFolds,
    setZoom,
    selectedSet,
    sourceResets,
    get setCompletionIndex() { return setCompletionIndex; },
    get setCompletion() { return setCompletion; },
    rewriteEditing: (id, next) => rewriteEditing(id, next),
    folds,
    inlineFields,
    setSelected,
    deleteTextRange,
    setTextRange,
    forgetReferenceSpace: (event) => forgetReferenceSpace(event),
    slashKey: (event) => slashKey(event),
    dateKey: (event) => dateKey(event),
    popupKey: (event) => popupKey(event),
    leaderMenu: (id) => leaderMenu(id),
    makeCloze: () => makeCloze(),
    openTable: (beside) => openTable(beside),
    rowRange,
    statusMenu: (id) => statusMenu(id),
    get scroll() { return scroll; },
    clearSelection,
    restoreSelection,
    selectedIds,
    get compositionSelection() { return !!compositionSelection; },
    baseDepth,
    positionSource,
    sourceDetails,
    virtualizer,
    hosts,
    coveredSet,
    glossId,
    margin,
    sigla,
    blockMenu: (id, anchor) => blockMenu(id, anchor),
    holderMenu: (id, anchor) => holderMenu(id, anchor),
    pointerStart: (event, id, element) => pointerStart(event, id, element),
    attach,
    referenceMenu: (id, anchor) => referenceMenu(id, anchor),
    selectedOffsets: (id) => selectedOffsets(id),
    conflicts,
    editedConflicts,
    setEditedConflicts,
  };
  const { openRelation, positionReason, placeReason, usePlace, RelationPopups } = createRelationActions(context, async holderId => {
    // The recipe offers only defined fields, so Tab from the Gist reaches Work only once work exists.
    const field = definitionsByName().get('gist') ?? await ensureField(props.notebook, 'gist', 'text', 'standfirst');
    const work = definitionsByName().get('work') ?? await ensureWorkField(props.notebook);
    setCreatedFields(previous => [...previous, ...[field, work].filter(created => !previous.some(existing => existing.id === created.id))]);
    const last = register().slips.at(-1)?.id;
    const parentId = last ? doc.outline.parentOf(last) : props.pageId;
    const result = doc.edit({ kind: 'addReading', parentId, after: last ?? doc.outline.children(parentId).at(-1) ?? null, holderId, gistFieldId: field.id }, caret());
    if (!result.ok) throw new Error(result.reason);
    await doc.flush();
    if (result.caret) requestAnimationFrame(() => editAt(result.caret!.id, 0, true));
  });
  const { openViewEmbed, ViewEmbedPopups } = createViewEmbedActions(context);
  const { openMoveToPage, MoveToPagePopup } = createMoveToPage(context);
  const { setCompletion, setCompletionIndex, offerValue, openValueEditor, closeValueEditor, valueEditorId, pendingReference, pendingType, syncCompletions, updateCompletion, updateTriggers, taskPrefix, rewriteEditing, referenceInput, forgetReferenceSpace, slashKey, dateKey, popupKey, CompletionPopups } = createOutlineCompletions(context, id => { fieldSheet.start(id); }, (id, backward) => fieldSheet.advance(id, backward));
  const { openTable, investigationItems, markRelation, relationMenu, commandDefinitions, unregister, blockMenu, holderMenu, fieldMenu, statusMenu, priorityMenu, openPlanning, openProject, leaderMenu, makeCloze, referenceMenu, copy } = createOutlineCommands(context);
  const { horizontal, adjacent, split, editorKey, structuralKey, pruneEmptyValue, resetRowKey, resetVerticalGoal } = createOutlineKeyboard(context, (event, id) => fieldSheet.key(event, id));
  const { selectedOffsets, pointerStart, pointerMove, pointerEnd, clipboard, paste, beforeInput } = createOutlineInteractions(context);
  const fieldSheet = createFieldSheet(context, {
    offerValue, onField: field => setCreatedFields(previous => previous.some(existing => existing.id === field.id) ? previous : [...previous, field]),
    controlledId: valueEditorId, closeControlled: closeValueEditor,
    hiddenCounts, revealed: revealedFields,
    reveal: owner => setRevealedFields(previous => { const next = new Set(previous); next.has(owner) ? next.delete(owner) : next.add(owner); return next; }),
  });
  const drag = createOutlineDrag(context);
  const images = createOutlineImages(context);
  const { related, relatedError, relatedLoading, apparatus, holders, holderRelations, linkedPages, Related, Backlinks, UnlinkedMentions, mentionsAvailable, ReferenceCount, RowRelations } = createOutlineRelated(context);
  const holderBoundary = createMemo(() => !zoom() && related()?.heldReadings.length
    ? ids().find(id => doc.outline.parentOf(id) === props.pageId && !!doc.block(id)?.heading) : undefined);
  const { Row, TaskSummary, QuestionSummary } = createOutlineRows(context, fieldSheet, drag, ReferenceCount, RowRelations, openValueEditor,
    row => <Show when={holderBoundary() === row.id}><HeldReadings rows={related()?.heldReadings ?? []} notebook={props.notebook} onOpen={props.onOpen} /></Show>, DiscoveryHints);
  const { CapabilityPopups } = createCapabilityPopups(context);
  const projectSummary = createProjectSummary({ doc, notebook: props.notebook, date: contextDate, onOpen: props.onOpen, onEdit: anchor => capabilities.open(props.pageId, 'project', anchor) });
  createEffect(on(() => props.projection, () => {
    if (props.projection !== 'read') setPendingReadAnchor(null);
    if (!scroll || restoring || props.projection === 'compare') return;
    const anchor = props.view.scroll;
    if (anchor) revealRow(anchor.id);
    requestAnimationFrame(() => {
      if (disposed) return;
      if (!reading() && anchor && indices().has(anchor.id)) virtualizer.scrollToIndex(indices().get(anchor.id)!, { align: 'start' });
      restoreAnchor(anchor);
      if (editing()) mountEditor(editing()!);
      scrolled();
    });
  }, { defer: true }));

  onMount(() => {
    const copy = (event: ClipboardEvent) => clipboard(event);
    const cut = (event: ClipboardEvent) => clipboard(event, true);
    scroll.addEventListener('copy', copy, true);
    scroll.addEventListener('cut', cut, true);
    const clearOutsideRows = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!scroll.contains(target) || target.closest('[data-block-id], button, input, [role="menu"], [role="dialog"]')) return;
      const belowRows = (target === scroll || target === list) && event.clientY >= list.getBoundingClientRect().bottom;
      if (event.button !== 0 || !belowRows || doc.status() !== 'ready' || depthFilter() !== undefined) { clearSelection(); return; }
      event.preventDefault();
      setTextRange(null);
      props.onActivate();
      const parentId = zoom() ?? props.pageId;
      const last = doc.outline.children(parentId).at(-1);
      if (last && doc.block(last)?.text === '' && !doc.isArchived(last) && doc.outline.children(last).length === 0) editAt(last, 0, true);
      else apply({ kind: 'insert', parentId, after: last ?? null }, true);
    };
    scroll.addEventListener('mousedown', clearOutsideRows);
    onCleanup(() => scroll.removeEventListener('mousedown', clearOutsideRows));
    document.addEventListener('pointerdown', resetVerticalGoal, true);
    // A rename is committed only by Enter or Save title; pressing anywhere else abandons it, as Escape does.
    const abandonTitle = (event: PointerEvent) => {
      if (!renaming() || mergeTarget()) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.outline-title-row, [role="dialog"], [role="menu"]')) return;
      closeTitle();
    };
    document.addEventListener('pointerdown', abandonTitle, true);
    onCleanup(() => { document.removeEventListener('pointerdown', resetVerticalGoal, true); document.removeEventListener('pointerdown', abandonTitle, true); });
    scroll.addEventListener('paste', paste, true);
    scroll.addEventListener('beforeinput', beforeInput, true);
    onCleanup(() => { scroll.removeEventListener('copy', copy, true); scroll.removeEventListener('cut', cut, true); scroll.removeEventListener('paste', paste, true); scroll.removeEventListener('beforeinput', beforeInput, true); cancelAnimationFrame(compositionFrame); });
    editor = new PaneEditor({
      rewrite: syncCompletions,
      key: editorKey,
      input: referenceInput,
      label: id => { const target = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id) ? props.notebook.lookup(id)() : undefined; return target ? plainText(target.text, reference => props.notebook.lookup(reference)) : undefined; },
      isSource: id => !!referenceSources()?.has(id),
      tag: (title, id) => {
        const target = id ? props.notebook.lookup(id)() : undefined;
        const name = target?.text || title || id || '';
        const kind = tagRegistry.error ? undefined : tagRegistry()?.kinds.find(kind => kind.tag && (id ? kind.type_id === id : foldName(kind.name) === foldName(title)));
        return { name, icon: kind ? noteKindIcon(kind) : undefined, unresolved: !!id && target === null };
      },
      nameMatches: name => editingNames.error ? undefined : editingNames()?.get(foldName(name)),
      referenceMenu: (token, anchor) => {
        const matches = editingNames.error ? undefined : editingNames()?.get(foldName(token.id!));
        if (editor?.id && matches && matches.length > 1) setMenu({ anchor, label: 'Choose an atom', header: <div class="menu-section">“{token.id}” names {matches.length} atoms</div>, items: nameMenuItems(props.notebook, editor.id, token, matches, setMessage) });
      },
      openReference: (token, beside) => {
        void (async () => {
          if (isViewReference(token)) {
            const view = (await props.notebook.api.views()).find(view => view.id === token.id);
            if (view && !disposed) props.onOpen({ kind: 'table', typeId: view.query.type, viewId: view.id, query: view.query }, beside);
            return;
          }
          if (token.kind === 'tag') {
            const id = token.id ?? await props.notebook.pageByTitle(token.value, false);
            if (id && !disposed) props.onOpen({ kind: 'page', pageId: id }, beside);
            return;
          }
          const matches = isStableReference(token) ? null : await resolveName(props.notebook, token.id!);
          const block = isStableReference(token)
            ? props.notebook.lookup(token.id!)() ?? await props.notebook.api.block(token.id!)
            : matches?.length === 1 ? matches[0]!.page : undefined;
          if (block && !disposed) props.onOpen({ kind: 'page', pageId: block.page_id, blockId: block.kind === 'block' ? block.id : undefined }, beside);
        })().catch(reason => setMessage(String(reason)));
      },
      blur: () => {
        const id = editor?.id;
        if (!id) return;
        setEditorFocused(false);
        doc.holdTag(id, pendingType(id));
        if (editing() === id) commitFieldEntry(id, false);
        queueMicrotask(() => {
          if (disposed || composition() || valueEditorId() === id) return;
          const replacement = pruneEmptyValue(id);
          if (replacement && editing() === id) { setEditing(null); setSelected(replacement); setCaret({ id: replacement, offset: 0 }); }
        });
      },
      text: (text, at, group) => measure('typing', () => {
        resetVerticalGoal();
        if (compositionSelection) return;
        hints.typed();
        const heading = composition() ? null : headingPrefix(doc.block(at.id)?.text ?? '', text, at.offset);
        const task = heading ? null : taskPrefix(text, at);
        if (heading) {
          const result = doc.edit({ kind: 'text', id: at.id, text: heading.text, heading: heading.heading, caret: heading.caret }, caret());
          if (!result.ok) { setMessage(result.reason); return; }
          queueMicrotask(() => { if (editor?.id === at.id) { editor.sync(heading.text); editor.view.dispatch({ selection: { anchor: heading.caret } }); } });
          text = heading.text; at = { id: at.id, offset: heading.caret };
          setCaret(at);
        } else if (task === false) return;
        else if (task) { text = task.text; at = task.caret; }
        else { const result = doc.edit({ kind: 'text', id: at.id, text, caret: at.offset, group }, caret()); if (!result.ok) setMessage(result.reason); }
        // Text left after an input rule still offers its completions, so a date typed with the prefix plans the task.
        doc.holdTag(at.id, pendingType(at.id) || !!typeTokenAt(text, at.offset));
        updateCompletion(text, at, true);
        updateTriggers(text, at);
      }),
      selection: at => {
        if (compositionSelection || textRange() && textRange()!.head.id !== at.id) return;
        focusEpoch++;
        setCaret(at);
        setTextRange(previous => previous && previous.head.id === at.id ? { anchor: previous.anchor, head: at } : previous);
        scrollReveal = { id: at.id, epoch: focusEpoch, caret: true };
        scheduleScroll();
        if (editor) { const text = editor.view.state.doc.toString(); doc.holdTag(at.id, pendingType(at.id) || !!typeTokenAt(text, at.offset)); updateCompletion(text, at, false); updateTriggers(text, at); }
        scheduleReport();
      },
      composition: composing,
      mode: mode => { if (editing()) props.onVimMode(props.vim ? mode : null); },
    });
    editor.configure(props.vim);
    editor.configureFields(id => definitionsById().get(id)?.name, name => definitionsByName().get(name.toLowerCase())?.kind);
    const observer = new ResizeObserver(() => { setMargin(list.offsetTop); scrolled(); });
    observer.observe(scroll.querySelector('.outline-heading')!);
    observer.observe(list);
    setMargin(list.offsetTop);
    document.addEventListener('mousemove', pointerMove);
    document.addEventListener('mouseup', pointerEnd);
    onCleanup(() => { observer.disconnect(); document.removeEventListener('mousemove', pointerMove); document.removeEventListener('mouseup', pointerEnd); });
  });
  createEffect(() => { const enabled = props.vim; if (editor) { editor.configure(enabled); props.onVimMode(enabled ? editing() ? editor.mode() : 'outline' : null); } });
  createEffect(() => { const byId = definitionsById(), byName = definitionsByName(); editor?.configureFields(id => byId.get(id)?.name, name => byName.get(name.toLowerCase())?.kind); });
  createEffect(() => {
    if (doc.status() !== 'ready' || !pageReady() || !scroll || !editor) return;
    if (restoring) {
      restoring = false;
      const saved = initial.caret;
      if (doc.root()?.kind !== 'journal') {
        const id = saved && doc.block(saved.id) && indices().has(saved.id) ? saved.id : null;
        if (id && initial.edit) {
          editAt(id, saved!.offset, !props.vim, !initial.scroll, true);
          scheduleReport();
          if (initial.scroll) restoreInitialAnchor();
          return;
        }
        setEditing(null);
        setSelected(id);
        // A foreign reading is selected through Related, not mounted as an editor in this document.
        setCaret(id ? { id, offset: id === saved?.id ? saved.offset : 0 } : reading() && saved && !doc.block(saved.id) ? saved : null);
        if (props.active) scroll.focus({ preventScroll: true });
        scheduleReport();
        if (initial.scroll) restoreInitialAnchor();
        return;
      }
      if (journalPeriod) {
        setEditing(null); setSelected(null); setCaret(null);
        if (props.active) scroll.querySelector<HTMLButtonElement>('.journal-trail-segment[aria-expanded="true"]')?.focus({ preventScroll: true });
        scheduleReport();
        return;
      }
      let first: Caret | null = saved && doc.block(saved.id) && indices().has(saved.id) ? saved : null;
      if (!saved) {
        const siblings = doc.outline.children(props.pageId);
        let empty: string | undefined;
        for (let index = siblings.length - 1; index >= 0; index--) {
          const id = siblings[index]!;
          if (doc.block(id)?.text === '' && !doc.block(id)?.archived) { empty = id; break; }
        }
        if (empty) first = { id: empty, offset: 0 };
        else {
          const result = doc.edit({ kind: 'insert', parentId: props.pageId, after: siblings.at(-1) ?? null }, null);
          if (result.ok) first = result.caret;
          else setMessage(result.reason);
        }
      } else if (!first) {
        // A page that opens on a field keeps it inline: select the value row instead of editing the reference.
        const id = ids()[0];
        if (id && inlineFields().has(doc.outline.parentOf(id))) setSelected(id);
        else first = id ? { id, offset: 0 } : null;
      }
      if (first && saved && !initial.edit) {
        setEditing(null);
        setSelected(first.id);
        setCaret(first);
        if (props.active) scroll.focus({ preventScroll: true });
        scheduleReport();
      } else if (first) editAt(first.id, first.offset, !props.vim, !initial.scroll, false);
      if (initial.scroll) restoreInitialAnchor();
    }
  });
  createEffect(() => {
    const anchor = pendingReadAnchor();
    if (!anchor || !reading() || doc.status() !== 'ready' || !pageReady() || fields.loading || positionQuestions.loading || relatedLoading()) return;
    if (!doc.block(anchor.id) && !related() && !relatedError()) return;
    untrack(() => revealRow(anchor.id));
    // Related readings and register fields mount asynchronously. Keep the requested location until
    // their existing presentation is ready, then hand the anchor to the common scroll settler.
    const frame = requestAnimationFrame(() => {
      if (disposed || !reading()) return;
      if (readingAnchor(anchor.id)) {
        restoreAnchor(anchor);
        if (initial.reveal === anchor.id) highlightReading(anchor.id);
      } else {
        if (caret()?.id === anchor.id && !doc.block(anchor.id)) setCaret(null);
        if (initial.reveal === anchor.id) setMessage('This perspective is no longer available on its subject atom.');
      }
      setPendingReadAnchor(null);
      scheduleReport();
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  createEffect(() => {
    const id = editing(), text = id ? doc.block(id)?.text : undefined;
    if (text !== undefined && editor?.id === id) queueMicrotask(() => {
      if (editor?.id !== id) return;
      if (editor.view.state.doc.toString() !== text) resetVerticalGoal();
      editor.sync(text);
    });
  });
  createEffect(() => {
    const id = editing();
    const text = id ? doc.block(id)?.text : undefined;
    if (text === undefined) return;
    if (!editingNames.error) editingNames();
    referenceSources();
    if (!tagRegistry.error) tagRegistry();
    for (const token of textTokens(text)) if (isStableReference(token) || token.kind === 'tag' && token.id) props.notebook.lookup(token.id!)();
    queueMicrotask(() => { if (!disposed && editor?.id === id) editor.refreshLabels(); });
  });
  let previousVisible: string[] = [];
  createEffect(() => {
    if (!pageReady()) return;
    const visible = ids(), before = previousVisible;
    previousVisible = visible;
    const id = editing() ?? selected();
    if (!id || visible.includes(id) || composition()) return;
    queueMicrotask(() => {
      if (disposed || composition() || focusRestoresPending || (editing() ?? selected()) !== id || indices().has(id)) return;
      selectSurvivor(id, before);
    });
  });
  createEffect(() => { storedFolds.set(`${props.pane}:${props.pageId}`, new Set(folds())); });
  onCleanup(() => {
    finishFoldMotion();
    reducedMotion.removeEventListener('change', finishFoldMotion);
    if (editing()) { doc.holdTag(editing()!, pendingType(editing()!)); commitFieldEntry(editing()!, false); }
    disposed = true;
    setLinkedCitation(null);
    unregister();
    doc.release();
    editor?.destroy();
    cancelAnimationFrame(reportingFrame);
    clearTimeout(scrollSettle);
    clearTimeout(revealTimer);
    revealedReading?.classList.remove('reading-reveal');
    cancelScroll();
  });

  reducedMotion.addEventListener('change', finishFoldMotion);

  // Only rendered static rows change groups; the active editor stays mounted.
  const foldGroups = createMemo(() => {
    const all = [...virtualItems().keys()].filter(id => id !== editing()), state = foldMotion();
    const groups = { before: [] as typeof all, children: [] as typeof all, after: [] as typeof all };
    const start = state ? indices().get(state.id) : undefined;
    if (!state || start === undefined) { groups.before = all; return groups; }
    const root = doc.outline.indexOf(state.id), end = doc.outline.subtreeEnd(root);
    for (const id of all) {
      const index = indices().get(id) ?? 0;
      const at = doc.outline.indexOf(id);
      groups[index <= start ? 'before' : at > root && at < end ? 'children' : 'after'].push(id);
    }
    return groups;
  });
  return <>
    <div ref={scroll} class="outline-pane" classList={{ 'has-apparatus': apparatus(), 'has-sigla': sigla().size > 0, 'source-page': !!doc.root()?.source && !zoom(), 'outline-dragging': drag.dragging(), 'projection-compare': props.projection === 'compare' }} style={{ visibility: pageReady() ? undefined : 'hidden' }} aria-busy={!pageReady()} data-pane-pending={pageReady() ? undefined : ''} data-pane={props.pane} data-projection={reading() ? 'read' : 'outline'} tabIndex={0} role="tree" aria-label={reading() ? 'Atom reading register' : 'Atom outline'} aria-owns={ids().map(id => `outline-${props.pane}-${id}`).join(' ')} onFocusIn={event => { props.onActivate(); if ((event.target as Element).closest('.cm-editor')) setEditorFocused(true); }} onFocusOut={report} onKeyDown={event => { finishFoldMotion(); structuralKey(event); }} onWheel={() => { finishFoldMotion(); cancelScroll(); }} onScroll={scrolled}>
      <Show when={doc.root()?.kind === 'page' && !zoom() && props.projection !== 'compare'}><div ref={navigator} class="section-navigator" classList={{ 'section-navigator-shown': longPage() && scrolledAway() }} onKeyDown={event => event.stopPropagation()}><Button aria-haspopup="menu" onClick={event => {
        const sections = Array.from({ length: doc.outline.size() }, (_, at) => doc.outline.idAt(at)).filter(id => !doc.isArchived(id) && (doc.block(id)?.position || doc.block(id)?.heading && doc.outline.parentOf(id) === props.pageId));
        setMenu({ anchor: event.currentTarget, label: 'Sections and perspectives', items: [{ label: 'Opening', action: () => { cancelScroll(); scroll.scrollTop = 0; scrolled(); } }, ...sections.map(id => ({ label: doc.block(id)?.position ? `Perspectives · ${doc.block(id)?.position?.holder_id ? props.notebook.lookup(doc.block(id)!.position!.holder_id!)()?.text ?? 'Loading holder…' : 'Unattributed'}` : plainText(doc.block(id)?.text ?? '', target => props.notebook.lookup(target)), action: () => {
          revealRow(id);
          if (!reading() && indices().has(id)) virtualizer.scrollToIndex(indices().get(id)!, { align: 'start' });
          requestAnimationFrame(() => {
            let row = rowAnchor(id);
            if (!row && reading()) {
              const start = doc.outline.indexOf(id), end = doc.outline.subtreeEnd(start);
              const child = ids().find(candidate => { const at = doc.outline.indexOf(candidate); return at > start && at < end; });
              if (child) row = rowAnchor(child);
            }
            if (row) scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - (navigator?.offsetHeight ?? 0);
            scrolled();
          });
        } }))] });
      }}>{sectionName() || 'Opening'}</Button></div></Show>
    <Show when={apparatus()}><Apparatus notebook={props.notebook} holders={holders()} linked={linkedPages()} relations={holderRelations()} sources={siglumSources().map(id => ({ id, siglum: sigla().get(id)! }))} onOpen={props.onOpen} /></Show>
    <Show when={sourceDetailsOpen() && doc.root()?.source}><SourceDetails notebook={props.notebook} pageId={props.pageId} onOpen={props.onOpen} onClose={() => setSourceDetailsOpen(false)} /></Show>
    <div ref={heading} class="outline-heading" style={{ visibility: doc.root()?.source && !sourceApparatusReady() ? 'hidden' : undefined }}>
      <Show when={zoom()}><nav class="outline-breadcrumbs" aria-label="Zoom breadcrumbs"><button type="button" onClick={() => zoomTo(null)}>{rootTitle()}</button><For each={breadcrumbs()}>{id => <><Icon name="right" /><button type="button" onClick={() => zoomTo(id)}>{plainText(doc.block(id)?.text ?? '', reference => props.notebook.lookup(reference), undefined, doc.block(id)?.position?.deleted_holder) || 'Empty atom'}</button></>}</For></nav></Show>
      <Show when={isNote()}><NoteEyebrow kinds={noteKinds.error ? undefined : noteKinds.latest} onOpen={props.onOpen} /></Show>
      <Show when={positionZoom()}>{id => <div class="position-dossier">
        <h1><Show when={doc.block(id())?.position?.holder_id ?? doc.block(id())?.position?.deleted_holder?.id} fallback="Unattributed">{holder => <BlockText text={`[[${holder()}]]`} deletedHolder={doc.block(id())?.position?.deleted_holder} notebook={props.notebook} onOpen={props.onOpen} />}</Show>
          <Show when={dossierFields().find(field => fieldRole(definitionsById().get(field.fieldId)) === 'standfirst')?.value}>{gist => <> · <BlockText text={gist()} notebook={props.notebook} onOpen={props.onOpen} /></>}</Show>
        </h1>
        <Show when={dossierFields().find(field => field.name.trim().toLowerCase() === 'work')?.value}>{work => <div class="dossier-work"><BlockText text={work()} notebook={props.notebook} onOpen={props.onOpen} /></div>}</Show>
        <Show when={doc.block(id())?.position?.subject_id}>{subject => <div class="dossier-subject">on <Button onClick={event => {
          const block = props.notebook.lookup(subject())();
          if (block) props.onOpen({ kind: 'page', pageId: block.page_id, ...(block.kind === 'block' ? { blockId: block.id } : {}) }, opensBeside(event));
        }}><span><BlockText text={props.notebook.lookup(subject())()?.text ?? 'Loading subject…'} notebook={props.notebook} interactive={false} /></span></Button></div>}</Show>
      </div>}</Show>
      <Show when={!positionZoom() && (!zoom() || !doc.root()?.source || renaming())}>
      <div class="outline-title-row">
      <Show when={renaming()} fallback={<h1 classList={{ 'outline-title-tagged': titleTags().length > 0 }}>
        <For each={titleTags().filter(token => isCapabilityTag(tagLabel(token, id => props.notebook.lookup(id))))}>{token => <Show when={titleTagKind(token)}>{kind => <Icon name={noteKindIcon(kind())} />}</Show>}</For>
        <button class="outline-title" type="button" disabled={doc.root()?.kind !== 'page'} onClick={rename}>{rootTitle() || 'Loading…'}</button>
        <For each={titleTags().filter(token => !isCapabilityTag(tagLabel(token, id => props.notebook.lookup(id))))}>{token => <TypePill id={token.id} title={token.alias || token.value} notebook={props.notebook} onOpen={props.onOpen} onRestoreFocus={restoreFocus} />}</For>
      </h1>}>
        <input ref={titleInput} class="title-input" aria-label="Atom title" value={title()} onInput={event => setTitle(event.currentTarget.value)} onKeyDown={event => { if (event.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); commitTitle(); } if (event.key === 'Escape') { event.preventDefault(); closeTitle(); } }} />
        <Show when={titleCollision()} fallback={<Button class="bordered" onClick={commitTitle}>Save title</Button>}>{page =>
          <Button class="bordered" disabled={!!pageMergeDisabledReason(doc.root(), doc.capabilities(props.pageId))} title={pageMergeDisabledReason(doc.root(), doc.capabilities(props.pageId))} onClick={event => { setMessage(''); setMergeTarget({ page: page(), from: { id: props.pageId, text: doc.root()!.text }, anchor: event.currentTarget }); }}>Merge into “{page().text}”</Button>
        }</Show><Button onClick={closeTitle}>Cancel</Button>
      </Show>
      <Show when={doc.root()?.kind === 'page' && !doc.root()?.source}><div class="outline-header-actions"><Button icon="table" label="Table" shortcut="⌘⇧T" onClick={event => openTable(opensBeside(event))}>Table<Show when={!doc.root()?.project && !type.error && (type()?.members ?? 0) > 0}><span class="table-member-count">{type()?.members}</span></Show></Button></div></Show>
      </div>
      </Show>
      <Show when={isNote()}><NoteAliases doc={doc} fields={definitions()} onEdit={entry => {
        setAliasesVisible(true);
        if (depth() !== 'full') setStop('full');
        const value = doc.outline.children(entry).find(id => !doc.isArchived(id));
        if (value) editAt(value, doc.block(value)?.text.length ?? 0, true);
      }} /><NoteLine pageId={props.pageId} notebook={props.notebook}><Show when={doc.status() === 'ready' && !doc.root()?.question}><NoteRevisit id={props.pageId} notebook={props.notebook} /></Show></NoteLine></Show>
      <Show when={isReadingSubject(doc) && !reading() && !zoom()}><div class="reading-register-actions"><span class="reading-counts">{readingCounts(register().slips)}</span><Show when={localPositions() > 1}><Button onClick={() => props.onProjection?.('compare')}>Compare</Button></Show><Button onClick={event => openRelation(props.pageId, 'reading', event.currentTarget)}>Add perspective</Button></div></Show>
      <RowRelations id={zoom() ?? props.pageId} />
      <Show when={!zoom() && doc.root()?.kind === 'page' && !doc.root()?.source && doc.root()?.text.toLowerCase() !== 'fields' && !type.error && type()}>{value => <Show when={value().members || value().fields.length || value().starting.length || value().card_templates}>
        <TemplateEditor type={value()} fields={definitions()} notebook={props.notebook} onError={setMessage} onOpen={props.onOpen} />
        <RecipeSection typeId={value().page.id} notebook={props.notebook} onOpen={props.onOpen} />
      </Show>}</Show>
      <Show when={doc.root()?.source && !positionZoom()}><SourceHeader doc={doc} notebook={props.notebook} resetItems={sourceResets} onOpen={props.onOpen} onError={setMessage} onDelete={props.onDelete}
        fields={definitions()} compact={!!zoom()} ready={pageReady() && sourceApparatusReady()} onReady={setSourceHeaderReady} onEditDetails={() => setSourceDetailsOpen(true)}
        highlights={zoom() || sourceHighlights.error ? undefined : sourceHighlights()} colors={sourceColors()} onColors={setSourceColors} grouped={sourceGrouped()} onGrouped={setSourceGrouped} fieldsVisible={sourceFieldsVisible()} onFieldsVisible={visible => { setSourceFieldsVisible(visible); scheduleReport(); }} /></Show>
      <Show when={doc.root()?.templateCards}><CardSummary blockId={props.pageId} cards={[]} templateCount={doc.root()?.templateCards ?? 0} notebook={props.notebook} onOpen={props.onOpen} /></Show>
      <Show when={!zoom()}><projectSummary.Summary /></Show>
      <Show when={!zoom() && (doc.root()?.task || doc.root()?.question || doc.root()?.citations.length)}><div class="outline-root-capabilities outline-capability-metadata">
        <Show when={doc.root()?.task}>
          <TaskStatusButton task={doc.root()?.task ?? null} disabled={capabilities.busy(props.pageId)} onRestoreFocus={restoreFocus} onChange={status => capabilities.status(props.pageId, status)} />
          <TaskSummary id={props.pageId} />
          <Button class="outline-planning" onClick={event => capabilities.open(props.pageId, 'work', event.currentTarget)}>Work sessions</Button>
        </Show>
        <QuestionSummary id={props.pageId} />
        <For each={doc.root()?.citations}>{citation => <CitationChip citation={citation} pageId={props.pageId} notebook={props.notebook} onOpen={props.onOpen} />}</For>
      </div></Show>
      <Show when={!zoom()}><QuestionParent info={doc.root()?.question} notebook={props.notebook} onOpen={props.onOpen} disabled={capabilities.busy(props.pageId)}
        onChange={anchor => capabilities.open(props.pageId, 'question-parent', anchor)} onRemove={() => { const question = doc.root()?.question; if (question) { const { parent: _, ...value } = question.state; capabilities.invoke(capabilities.edit(props.pageId, { kind: 'question', id: props.pageId, value })); } }} /></Show>
      <For each={doc.root()?.citations}>{citation => <Show when={doc.root()?.text.trim() !== citation.quote.trim()}>
        <p class="outline-citation-quote" title={citation.quote}>{citation.quote}</p>
      </Show>}</For>
      <Show when={capabilities.error(props.pageId)}><p class="outline-capability-error" role="alert">{capabilities.error(props.pageId)}</p></Show>
      <Show when={showArchived()}><p class="archive-notice">Showing archived atoms <button type="button" class="text-button" onClick={() => { setShowArchived(false); scheduleReport(); }}>Hide archived</button></p></Show>
      <Show when={message()}><p class="outline-message" role="alert">{message()} <button class="text-button" type="button" onClick={() => setMessage('')}>Dismiss</button></p></Show>
      <Show when={doc.status() === 'error' || doc.status() === 'missing'}><p role="alert">{doc.statusMessage()}</p></Show>
      <Show when={doc.status() === 'ready' && depth() === 'gloss' && !zoom() && !glossId()}>
        <p class="empty-state">No gloss yet. Choose Gloss in the atom menu to write a one-line summary.</p>
      </Show>
      <Show when={!zoom() && doc.root()?.kind === 'journal'}>
        <JournalHeader date={doc.root()!.text} journalPeriod={journalPeriod} notebook={props.notebook} onOpen={props.onOpen} />
      </Show>
      <fieldSheet.FieldSlots id={props.pageId} />
      <Show when={!zoom() && doc.root()?.spread}><SpreadPane doc={doc} notebook={props.notebook} onActivate={props.onActivate} onOpen={props.onOpen} /></Show>
    </div>
    <Show when={!zoom() && !ids().length && related()?.heldReadings.length}><HeldReadings rows={related()?.heldReadings ?? []} notebook={props.notebook} onOpen={props.onOpen} /></Show>
    <Show when={!zoom() && doc.root()?.question}>
      <Show when={branches.error}><p class="error" role="alert">Couldn't load branches · {String(branches.error)}</p></Show>
      <Show when={!branches.error}><QuestionBranches rows={branches() ?? []} notebook={props.notebook} onOpen={props.onOpen} /></Show>
      <AssessmentJournal questionId={props.pageId} doc={doc} notebook={props.notebook} onOpen={props.onOpen}
        onWrite={() => apply({ kind: 'writeAssessment', parentId: props.pageId, assessedOn: props.notebook.todayDate() }, true)} />
    </Show>
    <div ref={list} class="outline-list" style={{ height: reading() ? undefined : `${listHeight()}px` }}>
      <Show when={reading()} fallback={<>
      <Show when={drag.indicator() ?? images.indicator()}>{drop => <div class="outline-drop-indicator" aria-hidden="true" data-drop-depth={drop().depth - baseDepth()} data-drop-edge={drop().edge} style={{ top: `${drop().top}px`, left: `${drop().left}px` }} />}</Show>
      <For each={foldGroups().before}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</For>
      <div ref={foldChildren} class="outline-motion-group" style={{ opacity: foldMotion()?.opening ? 0 : undefined }}>
        <For each={foldGroups().children}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</For>
      </div>
      <div ref={foldFollowing} class="outline-motion-group" style={{ transform: foldMotion()?.opening ? `translateY(${foldMotion()!.beforeSize - virtualizer.getTotalSize()}px)` : undefined }}>
        <For each={foldGroups().after}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</For>
      </div>
      <div ref={foldEditor} class="outline-motion-group" style={{ transform: foldMotion()?.opening && foldMotion()!.afterIds.includes(editing()!) ? `translateY(${foldMotion()!.beforeSize - virtualizer.getTotalSize()}px)` : undefined }}>
        <Show keyed when={editing() && virtualItems().has(editing()!) ? editing() : null}>{id => <Row id={id} item={() => virtualItems().get(id)!} />}</Show>
      </div>
      </>}>
        <ReadRegister register={readView()} doc={doc} notebook={props.notebook} disclosures={readDisclosures()} onDisclosure={key => {
          setReadDisclosures(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; });
          scheduleReport(); requestAnimationFrame(scrolled);
        }} row={id => <Row id={id} natural />} onCompare={() => props.onProjection?.('compare')} onAddReading={anchor => openRelation(props.pageId, 'reading', anchor)}
          onWriteAssessment={id => apply({ kind: 'writeAssessment', parentId: id, assessedOn: props.notebook.todayDate() }, true)}
          onOpenReading={(id, beside) => beside ? props.onOpen({ kind: 'page', pageId: props.pageId, blockId: id }, true) : zoomTo(id)}
          siglum={id => { const source = positionSource(id); return source ? sigla().get(source) : undefined; }} />
      </Show>
    </div>
    <Show when={!zoom() && ids().length && !holderBoundary() && related()?.heldReadings.length}><HeldReadings rows={related()?.heldReadings ?? []} notebook={props.notebook} onOpen={props.onOpen} /></Show>
    <Show when={doc.root()?.source && !zoom() && filedElsewhere().length}><section class="related-sections source-elsewhere" aria-label="Filed elsewhere">
      <h3 class="outline-highlights-label">Filed elsewhere <span>{filedElsewhere().length}</span></h3>
      <For each={filedElsewhere()}>{row => <Button class="library-highlight" onClick={event => props.onOpen({ kind: 'page', pageId: row.block.page.id, blockId: row.block.block.id }, opensBeside(event))}>
        <BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} />
        <span class="library-highlight-meta">¶{row.citation.ordinal + 1} · {row.block.page.text}</span>
      </Button>}</For>
    </section></Show>
    <Show when={!zoom() && sourceHighlights.error}><p class="library-error" role="alert">{String(sourceHighlights.error)}</p></Show>
    <Show when={doc.root()?.source && fields.error}><p class="library-error" role="alert">{String(fields.error)}</p></Show>
    <Show when={doc.status() === 'ready' && ids().length === 0 && depthFilter() === undefined}><button type="button" class="add-first-block" onClick={() => apply({ kind: 'insert', parentId: zoom() ?? props.pageId, after: null }, true)}><Icon name="plus" />Add an atom</button></Show>
    <Show when={!zoom() && doc.root()?.kind === 'journal'}><div class="related-sections journal-highlights"><Show when={doc.root()!.text === props.notebook.todayDate()}><ResearchToRevisit notebook={props.notebook} onOpen={props.onOpen} /></Show><JournalResurface date={doc.root()!.text} notebook={props.notebook} onOpen={props.onOpen} /></div></Show>
    <Show when={doc.status() === 'ready' && !zoom() && related()?.works.length}><PersonWorks pageId={props.pageId} rows={related()!.works} onOpen={props.onOpen} /></Show>
    <Show when={!zoom()}><projectSummary.LinkedTasks /></Show>
    <Show when={doc.status() === 'ready' && !zoom() && (doc.root()?.project || doc.root()?.manual_types.some(title => title.toLocaleLowerCase() === 'stream'))}><Arrivals doc={doc} notebook={props.notebook} onOpen={props.onOpen} onAdded={restoreFocus} /></Show>
    <Show when={doc.status() === 'ready' && !zoom() && (mentionsAvailable() || relatedError() || (related()?.total ?? 0) + (related()?.tagged.length ?? 0) + (related()?.about.length ?? 0) > 0)}><div class="related-sections">
      <Show when={related()?.about.length}><Related title="Perspectives filed elsewhere" rows={related()?.about ?? []} revealId={reading() ? pendingReadAnchor()?.id ?? props.view.scroll?.id : undefined} expanded={readDisclosures().has('related:positions')} onExpanded={expanded => {
        setReadDisclosures(previous => { const next = new Set(previous); expanded ? next.add('related:positions') : next.delete('related:positions'); return next; });
        scheduleReport();
      }} relations /></Show>
      <Show when={doc.root()?.source}><Backlinks cited /></Show>
      <Show when={doc.root()?.source || relatedError() || related()?.total}><Backlinks /></Show>
      <Show when={mentionsAvailable()}><UnlinkedMentions /></Show>
      <Show when={relatedError() || related()?.tagged.length}><Related title="Tagged atoms" rows={relatedError() ? [] : related()?.tagged ?? []} /></Show>
    </div></Show>
    <Show when={doc.status() === 'ready' && zoom()}><div class="related-sections"><Backlinks /></div></Show>
    <Show keyed when={menu()}>{state => <Menu anchor={state.anchor} label={state.label} title={state.title} context={state.context} header={state.header} items={state.items} onDismiss={() => { setMenu(null); restoreFocus(); }} />}</Show>
    <Show keyed when={mergeTarget()}>{target => <PageMergeConfirmation anchor={target.anchor} notebook={props.notebook} from={target.from} into={target.page} onDismiss={() => setMergeTarget(undefined)} onMerged={id => { setMergeTarget(undefined); props.onOpen({ kind: 'page', pageId: id }, false); }} />}</Show>
    <Show when={tagTemplate()}>{target => <Popup anchor={target().anchor} label={receiptType.error ? 'Tag fields' : `Fields for #${receiptType()?.page.text ?? ''}`} class="tag-template-popup" width={560} fitContent ready={!receiptType.loading || !!receiptType.error} onDismiss={() => setTagTemplate(undefined)}>
      <Show when={receiptType.error}><p class="error" role="alert">Couldn't load template · {String(receiptType.error)}</p></Show>
      <Show when={!receiptType.error && receiptType()}>{value => <TemplateEditor type={value()} fields={definitions()} notebook={props.notebook} onError={setMessage} onOpen={props.onOpen} register={{ fields: fields()?.fields ?? [], pageId: value().page.id }} />}</Show>
    </Popup>}</Show>
    <CapabilityPopups />
    <CompletionPopups />
    <fieldSheet.Popups />
    <RelationPopups />
    <ViewEmbedPopups />
    <MoveToPagePopup />
    <images.ImagePopups />
  </div>
    <Show when={props.projection === 'compare'}><div class="embedded-comparison"><ComparePane subjectId={props.pageId} view={props.view.compare ?? { scroll: 0 }} notebook={props.notebook} onActivate={props.onActivate} onOpen={props.onOpen} onViewChange={compare => props.onViewChange({ ...props.view, compare })} /></div></Show>
    <div class="outline-notices">
      <Show when={notice()}>{value => <div class="undo-toast" role="status" onPointerEnter={() => setNoticeHeld(true)} onPointerLeave={() => setNoticeHeld(false)} onFocusIn={() => setNoticeHeld(true)} onFocusOut={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setNoticeHeld(false); }}>
        <span>{value().label}</span>
        <Show when={value().undo}><Button class="notice-undo" icon="undo" disabled={noticeBusy()} onClick={() => { void undoNotice(); }}>Undo</Button></Show>
        <Show when={value().action}>{action => <>
          <Button class="notice-undo" disabled={noticeBusy()} onClick={() => { void runNoticeAction(); }}>{action().label}</Button>
          <Button class="notice-undo" disabled={noticeBusy()} onClick={() => setNotice(null)}>Not now</Button>
        </>}</Show>
        <Show when={!value().action}><Button icon="close" label="Dismiss change notice" disabled={noticeBusy()} onClick={() => setNotice(null)} /></Show>
      </div>}</Show>
    </div>
  </>;
}
