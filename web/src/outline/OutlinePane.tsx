import { opensBeside } from '../core/beside';
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  lazy,
  mapArray,
  on,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import type { FieldDefinition, PositionQuestion } from '../api/types';
import type { Edit, EditResult, PageDocument, TextRange } from '../document/contract';
import { depthStops } from '../core/contract';
import type { Caret, Depth } from '../core/contract';
import type { OutlinePaneProps } from './contract';
import { fieldEntryId } from '../core/field-entry';
import { setLinkedCitation } from '../library/highlights';
import { createTemplateCache, typeKeys } from '../fields/templates';
import { TemplateEditor } from '../fields/TemplateEditor';
import { citedSigla } from '../library/sigla';
import { sourceReadingOrder } from '../library/source-order';
import { isCatalogueField } from '../library/details';
import { fieldHide } from '../core/hide';
import { hasValueEditor } from '../fields/value-options';
import { PersonWorks } from '../library/PersonWorks';
import type { OutlineIndex } from '../document/outline-index';
import { spokenJournalDate } from '../tasks/journal-date';
import { DatePicker } from '../tasks/DatePicker';
import { isFinished } from '../tasks/task-labels';
import { JournalResurface } from '../tasks/JournalResurface';
import { ResearchToRevisit } from '../review/ResearchToRevisit';
import { createProjectSummary } from '../projects/ProjectSummary';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { showNotice as presentNotice, type NoticeAction } from '../ui/Notice';
import { Popup } from '../ui/Popup';
import { createVisualViewport } from '../ui/visual-viewport';
import { isPhone, isVirtualKeyboardOpen, matchesCoarsePointer } from '../ui/viewport';
import { BlockText } from './BlockText';
import { displayTitle, plainText, tagLabel } from './names';
import { titleKey } from '../document/title-key';
import { isStableReference, isViewReference, textTokens } from '../document/text-tokens';
import type { Token } from '../document/text-tokens';
import { PaneEditor } from './editor';
import { createOutlineCapabilities, isCapabilityTag } from './capabilities';
import {
  editingDepth,
  hiddenFieldEntries,
  inlineFieldValues,
  selectionIds,
  survivingZoomPath,
  visibleIds,
} from './visibility';
import type { DepthFilter, HiddenFieldEntry } from './visibility';
import { glossEntry } from './gloss';
import { positionFields, positionSource as sharedPositionSource } from './perspectives';
import {
  createFieldEntryConversion,
  createSourceFieldResets,
  ensureField,
  isFreshField,
  settleField,
} from './source-fields';
import { addTemplateField, setFreshFieldKind } from '../fields/commands';
import { templateOffer } from '../fields/template-offer';
import { createOutlineHints } from './hints';
import { kindNoun } from '../fields/kinds';
import { guessFieldKind } from '../fields/value-reading';
import { sourceFieldName } from './source';
import { contentsTitle } from '../reader/openings';
import { createOutlineCompletions } from './completions';
import { headingPrefix } from './completion';
import { createOutlineCommands } from './commands';
import { createOutlineKeyboard } from './keyboard';
import { createOutlineInteractions } from './interactions';
import { createOutlineRows } from './Row';
import { MissingSections, createJournalLayout } from './journal-sections';
import { section } from '../tasks/today-template';
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
import type { MenuState, OutlineContext } from './context';
import { PageMergeConfirmation } from './PageMerge';
import { readTagRegistry } from './references';
import { eyebrowNamesTag, noteKindIcon } from '../notes/kinds';
import { aliasesInHeader } from '../notes/aliases';
import { foldName, nameMenuItems, resolveName } from './names';
import { titleTargets, typedTitles, withLinkedTitles } from './link-titles';
import { createCitationSources, createCitedSources, hasCitationDetail } from './source-reads';
import { HeldReadings } from './HeldReadings';
import { ReadRegister } from './ReadRegister';
import { localPositionCount, readingDisagreementRows, readingRegister, readingSlipRows } from './read-register';
import { typeTokenAt } from './type-completion';
import { createOutlineHeaderActions, OutlineEditingBar, OutlineHeader } from './OutlineHeader';
import { createOutlineSelection } from './selection';
import { createOutlineViewport } from './viewport';
import './outline.css';
import './read-register.css';
const ComparePane = lazy(() => import('../compare/ComparePane').then(module => ({ default: module.ComparePane })));

const storedFolds = new Map<string, Set<string>>();

export function OutlinePane(props: OutlinePaneProps) {
  return (
    <Show keyed when={props.pageId}>
      {pageId => <Pane {...props} pageId={pageId} />}
    </Show>
  );
}

function Pane(props: OutlinePaneProps) {
  const doc: PageDocument = props.workshop.open(props.pageId);
  const creatingRoot = createMemo(() => doc.root()?.revision === 0);
  const viewport = createVisualViewport();
  const initial = untrack(() => props.view);
  const journalPeriod = untrack(() => props.journalPeriod);
  const reading = () => props.projection === 'read' && !zoom();
  const [readDisclosures, setReadDisclosures] = createSignal(new Set(initial.readDisclosures ?? []));
  const readingSubjects = createMemo(() => {
    doc.outline.version();
    doc.archivedVersion();
    const subjects = new Set([props.pageId]);
    for (let at = 0; at < doc.outline.size(); at++) {
      const id = doc.outline.idAt(at),
        position = doc.block(id)?.position;
      if (position && !doc.isArchived(id) && doc.block(position.subject_id)?.question)
        subjects.add(position.subject_id);
    }
    return [...subjects].join(',');
  });
  const [positionQuestions] = createResource(
    () =>
      !creatingRoot() && doc.root()?.kind === 'page'
        ? ([readingSubjects(), props.workshop.changed('inquiry'), props.workshop.connection() === 'live'] as const)
        : false,
    async ([subjects]) => {
      const results = await Promise.all(subjects.split(',').map(subject => props.workshop.api.positions({ subject })));
      const questions = new Map<string, PositionQuestion>();
      for (const result of results)
        for (const question of result.questions) {
          const id = question.block.block.id;
          if (!questions.has(id) || question.criterion) questions.set(id, question);
        }
      return { questions: [...questions.values()] };
    },
  );
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
  const rootTitle = () => {
    const root = doc.root();
    return root?.kind === 'journal'
      ? spokenJournalDate(root.text)
      : root?.kind === 'page'
        ? displayTitle(root.text, id => props.workshop.lookup(id))
        : root?.text;
  };
  const titleTags = createMemo(() => {
    const root = doc.root();
    return root?.kind === 'page' ? textTokens(root.text).filter(token => token.kind === 'tag') : [];
  });
  const titleTagKind = (token: Token) =>
    tagRegistry.error
      ? undefined
      : tagRegistry()?.kinds.find(
          kind => kind.tag && (token.id ? kind.type_id === token.id : foldName(kind.name) === foldName(token.value)),
        );
  createEffect(() => {
    if (doc.status() === 'ready' && zoomTarget() !== zoom()) setZoom(zoom());
  });
  const [folds, setFolds] = createSignal(
    new Set(initial.folds ?? storedFolds.get(`${props.pane}:${props.pageId}`) ?? []),
  );
  const [showArchived, setShowArchived] = createSignal(initial.showArchived);
  const [depth, setDepth] = createSignal<Depth>(initial.depth ?? 'full');
  let editingBar: HTMLDivElement | undefined;
  let scroll!: HTMLDivElement;
  let list!: HTMLDivElement;
  let heading!: HTMLDivElement;
  const hosts = new Map<string, HTMLElement>();
  let editor: PaneEditor | undefined;
  let restoring = true;
  let disposed = false;
  let focusEpoch = 0;
  let focusRequest: { id: string; offset: number; insert: boolean; epoch: number; focus: boolean } | null = null;
  /** A navigation open restores the caret without scrolling it into view. Cleared when the reader acts, or when an open names a row to reveal. */
  let suppressCaretScroll = false;
  /** While set, a browser or CodeMirror focus scroll is put back so a journal opens on its title. */
  let holdOpeningScroll = false;
  let focusRestoresPending = 0;
  let reportingFrame = 0;

  const selection = createOutlineSelection({
    initialCaret: initial.caret,
    doc,
    ids: () => ids(),
    indices: () => indices(),
    disposed: () => disposed,
    active: () => props.active,
    vim: () => props.vim,
    onVimMode: props.onVimMode,
    editor: () => editor,
    scroll: () => scroll,
    bumpFocusEpoch: () => ++focusEpoch,
    clearFocusRequest: () => {
      focusRequest = null;
    },
    clearCompletion: () => setCompletion(null),
    resetRowKey: () => resetRowKey(),
    scheduleReport: () => scheduleReport(),
    replaceSelection: (text, mode, range) => replaceSelection(text, mode, range),
  });
  const {
    caret,
    setCaret,
    editing,
    setEditing,
    editorFocused,
    setEditorFocused,
    selected,
    setSelected,
    rowRange,
    setRowRange,
    textRange,
    setTextRange,
    composition,
    selectedIds,
    selectedSet,
    coveredSet,
    roots,
    selectSurvivor,
    clearSelection,
    activeRange,
    restoreSelection,
    composing,
  } = selection;
  const editingBarVisible = () =>
    props.active && editorFocused() && !!editing() && isPhone() && isVirtualKeyboardOpen(viewport().height);
  const [message, setMessage] = createSignal('');
  /** A change with its Undo, or an offer whose action stands in for Undo, routed through the shared shell notice. */
  let pendingUndo: { run(): Promise<void>; dismiss(): void } | null = null;
  let undoBusy = false;
  let dismissOutlineNotice: (() => void) | undefined;
  onCleanup(() => dismissOutlineNotice?.());
  function showNotice(label: string, undo?: () => Promise<void>, action?: { label: string; run: () => Promise<void> }) {
    setMessage('');
    const actions: NoticeAction[] = [];
    let entry: { run(): Promise<void>; dismiss(): void } | null = null;
    const runUndo = async () => {
      if (!undo || undoBusy) return;
      undoBusy = true;
      try {
        await undo();
      } finally {
        undoBusy = false;
        restoreFocus();
      }
    };
    if (undo) actions.push({ label: 'Undo', icon: 'undo', run: runUndo });
    if (action) {
      actions.push(
        {
          label: action.label,
          run: async () => {
            try {
              await action.run();
            } catch (error) {
              setMessage(error instanceof Error ? error.message : String(error));
              dismiss();
            } finally {
              restoreFocus();
            }
          },
        },
        { label: 'Not now', run: () => {} },
      );
    }
    const dismiss = presentNotice({
      text: label,
      action: actions,
      duration: 10000,
      dismissLabel: action ? null : 'Dismiss change notice',
      onError: error => setMessage(error instanceof Error ? error.message : String(error)),
      onClose: () => {
        if (pendingUndo === entry) pendingUndo = null;
        if (dismissOutlineNotice === dismiss) dismissOutlineNotice = undefined;
      },
    });
    dismissOutlineNotice = dismiss;
    if (undo) {
      entry = {
        run: async () => {
          try {
            await runUndo();
            dismiss();
          } catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
          }
        },
        dismiss,
      };
      pendingUndo = entry;
    }
  }
  // A newer outline edit returns keyboard history to this document. Until then the notice owns Undo.
  createEffect(
    on(
      () => doc.saveState(),
      state => {
        if (state !== 'saved' && pendingUndo) pendingUndo.dismiss();
      },
      { defer: true },
    ),
  );
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [tagRegistry] = createResource(
    () => [props.workshop.changed('pages'), props.workshop.connection()] as const,
    () => readTagRegistry(props.workshop),
  );
  const [conflicts, setConflicts] = createSignal(new Set<string>());
  const [editedConflicts, setEditedConflicts] = createSignal(new Set<string>());
  const [createdFields, setCreatedFields] = createSignal<FieldDefinition[]>([]);
  const live = createMemo(() => props.workshop.connection() === 'live');
  const [fields] = createResource(
    () => [props.workshop.changed('fields'), live()] as const,
    () => props.workshop.api.fields(),
  );
  const definitions = createMemo(
    () => {
      const result = new Map<string, FieldDefinition>(
        (fields.error ? [] : (fields()?.fields ?? [])).map(field => [field.id, field]),
      );
      for (const field of createdFields()) if (!result.has(field.id)) result.set(field.id, field);
      return [...result.values()].filter(field => {
        const block = props.workshop.lookup(field.id)();
        return block !== null && !block?.archived;
      });
    },
    undefined,
    {
      // Fields refetch after every committed change; unchanged definitions must not reconfigure the editor or re-scan rows.
      equals: (a, b) =>
        a.length === b.length &&
        a.every((field, index) => {
          const other = b[index]!;
          return (
            field.id === other.id &&
            field.revision === other.revision &&
            field.name === other.name &&
            field.kind === other.kind &&
            JSON.stringify(field.options) === JSON.stringify(other.options)
          );
        }),
    },
  );
  const definitionsById = createMemo(() => new Map(definitions().map(field => [field.id, field])));
  const definitionsByName = createMemo(() => new Map(definitions().map(field => [field.name.toLowerCase(), field])));
  // Clicking the ALSO line reveals the Aliases entries it presents, in Outline and Read alike.
  const [aliasesVisible, setAliasesVisible] = createSignal(false);
  const register = createMemo(
    () =>
      readingRegister(
        doc,
        id => definitionsById().get(id),
        positionQuestions.error ? [] : (positionQuestions()?.questions ?? []),
        aliasesVisible(),
      ),
    undefined,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  const templates = createTemplateCache(
    props.workshop.api,
    () => (fields.error ? undefined : fields()),
    props.workshop.lastChange,
  );
  const glossId = createMemo(() =>
    doc.root()?.kind === 'page' ? glossEntry(doc, id => fieldRole(definitionsById().get(id)) === 'standfirst') : null,
  );
  const depthFilter = createMemo<DepthFilter | undefined>(() =>
    !reading() && doc.root()?.kind === 'page' && depth() !== 'full'
      ? {
          stop: depth(),
          gloss: glossId(),
          position: id => !!doc.block(id)?.position,
          gist: id => fieldRole(definitionsById().get(fieldEntryId(doc.block(id)?.text ?? '') ?? '')) === 'standfirst',
        }
      : undefined,
  );
  const [type] = createResource(
    () =>
      !creatingRoot() && doc.root()?.kind === 'page'
        ? ([props.pageId, props.workshop.changed('types'), live()] as const)
        : false,
    ([pageId]) => props.workshop.api.type(pageId),
  );
  const [editingNames] = createResource(
    () => {
      const id = editing();
      const names = id
        ? [
            ...new Set(
              textTokens(doc.block(id)?.text ?? '').flatMap(token =>
                token.kind === 'reference' && !isStableReference(token) && !isViewReference(token) ? [token.id!] : [],
              ),
            ),
          ]
        : [];
      return names.length ? ([names.join('\u0000'), props.workshop.changed('pages')] as const) : false;
    },
    async ([names]) =>
      new Map(
        await Promise.all(
          names.split('\u0000').map(async name => [foldName(name), await resolveName(props.workshop, name)] as const),
        ),
      ),
  );
  const sourceResets = createSourceFieldResets({
    doc,
    workshop: props.workshop,
    definitions: definitionsById,
    caret,
    onError: setMessage,
  });
  const hints = createOutlineHints({
    workshop: props.workshop,
    doc,
    editing: () => (editorFocused() ? editing() : null),
    visible: () => ids(),
    fieldKnown: id => definitionsById().has(id),
  });
  const [tagTemplate, setTagTemplate] = createSignal<{ id: string; anchor: HTMLElement }>();
  const [receiptType] = createResource(
    () => {
      const target = tagTemplate();
      return target ? ([target.id, props.workshop.changed('types'), live()] as const) : false;
    },
    ([id]) => props.workshop.api.type(id),
  );
  function DiscoveryHints(row: { id: string }) {
    return (
      <For each={hints.forBlock(row.id)}>
        {hint => (
          <div class="outline-discovery" role="status" onMouseDown={event => event.stopPropagation()}>
            <Show
              when={hint.kind === 'tag' ? hint.type : undefined}
              fallback={
                <span>
                  {hint.kind === 'card'
                    ? 'a card · tag it to put it in a deck'
                    : 'a field · its tag can carry it as a template'}
                </span>
              }
            >
              {type => (
                <>
                  <span>#{type().title} is new</span>
                  <span aria-hidden="true">·</span>
                  <Button
                    class="notice-undo"
                    aria-haspopup="dialog"
                    aria-expanded={tagTemplate()?.id === type().id}
                    onClick={event =>
                      setTagTemplate({
                        id: type().id,
                        anchor: event.currentTarget.closest<HTMLElement>('.outline-discovery')!,
                      })
                    }
                  >
                    Add fields
                  </Button>
                  <span aria-hidden="true">·</span>
                  <Button
                    class="notice-undo"
                    onClick={event => props.onOpen({ kind: 'page', pageId: type().id }, opensBeside(event))}
                  >
                    Open
                  </Button>
                </>
              )}
            </Show>
          </div>
        )}
      </For>
    );
  }

  const contextDate = () => (doc.root()?.kind === 'journal' ? doc.root()!.text : props.workshop.todayDate());
  const rowAnchor = (id: string) =>
    id === props.pageId ? (heading ?? null) : (hosts.get(id)?.closest<HTMLElement>('[data-block-id]') ?? null);
  const readingAnchor = (id: string) =>
    scroll?.querySelector<HTMLElement>(`[data-reading-id="${CSS.escape(id)}"]`) ?? rowAnchor(id);
  const capabilities = createOutlineCapabilities({
    doc,
    workshop: props.workshop,
    contextDate,
    caret,
    historyCaret: () => {
      const current = caret();
      if (!current) return null;
      const selection =
        rowRange() ?? (selected() && !editing() ? { anchor: selected()!, head: selected()! } : undefined);
      return selection ? { ...current, selection } : current;
    },
    anchor: rowAnchor,
    onOpen: props.onOpen,
    onTaskFields: (id, field, opener) => fieldSheet.openTask(id, field, opener),
  });
  const [bulkDate, setBulkDate] = createSignal<{
    ids: string[];
    field: 'scheduled' | 'deadline';
    anchor: HTMLElement;
  } | null>(null);

  const fieldConversion = createFieldEntryConversion({
    doc,
    workshop: props.workshop,
    disposed: () => disposed,
    composing: composition,
    caret,
    focusEpoch: () => focusEpoch,
    known: name => definitionsByName().get(name.toLowerCase()),
    targetKind: id => props.workshop.lookup(id)()?.kind,
    onStart: () => setCompletion(null),
    onField: field =>
      setCreatedFields(previous =>
        previous.some(existing => existing.id === field.id) ? previous : [...previous, field],
      ),
    onCommitted: (id, next, epoch, focus, field) => {
      setMessage('');
      offerTemplateField(id);
      hints.fieldEntry(id);
      setFolds(previous => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      if (next && focusEpoch === epoch) {
        setSelected(next.id);
        setCaret(next);
        setRowRange(null);
        setTextRange(null);
        setEditing(next.id);
        if (focus && props.active)
          queueMicrotask(() => {
            editAt(next.id, next.offset, true, true, false);
            offerValue(next.id, field);
          });
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
    void templateOffer(props.workshop, owner, fieldId).then(
      offer => {
        if (!offer || disposed) return;
        const name = definitionsById().get(fieldId)?.name ?? 'This field';
        // The tag as the owner spells it, else the type's title.
        const typed = textTokens(owner.text).find(
          token =>
            token.kind === 'tag' &&
            (token.id
              ? token.id === offer.type.page.id
              : titleKey(token.value.trim()) === titleKey(offer.type.page.text)),
        );
        const tag = typed ? `#${offer.type.page.text}` : offer.type.page.text;
        showNotice(`${name} is on another ${tag} too.`, undefined, {
          label: `Add to ${tag}`,
          run: async () => {
            const change = await addTemplateField(props.workshop, offer.type, fieldId);
            showNotice(`${name} added to ${tag}.`, change.undo);
          },
        });
      },
      () => {},
    );
  }
  /** Leaving the first value of a field `name::` just created gives the field the kind that value suggests. */
  function settleFreshField(id: string) {
    const fieldId = fieldEntryId(doc.block(doc.outline.parentOf(id))?.text ?? '');
    const text = doc.block(id)?.text.trim();
    if (!fieldId || !text || !isFreshField(props.workshop, fieldId)) return;
    settleField(props.workshop, fieldId);
    const kind = guessFieldKind(text, target => props.workshop.lookup(target)()?.kind);
    const name = definitionsById().get(fieldId)?.name ?? 'This field';
    if (kind)
      void setFreshFieldKind(props.workshop, fieldId, kind).then(
        change => showNotice(`${name} is now a ${kindNoun(kind)} field.`, change.undo),
        reason => setMessage(reason instanceof Error ? reason.message : String(reason)),
      );
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
        const targets = await titleTargets(props.workshop, titles);
        const current = doc.block(id)?.text;
        if (disposed || editing() === id || !current) return;
        const next = withLinkedTitles(current, targets);
        if (next === current) return;
        const result = doc.edit({ kind: 'text', id, text: next }, caret());
        if (!result.ok) setMessage(result.reason);
      } catch (error) {
        if (!disposed) setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        linking.delete(id);
      }
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
    const colors = sourceColors(),
      showFields = sourceFieldsVisible();
    const shown = visible.filter(id => {
      const parent = doc.outline.parentOf(id),
        root = parent === props.pageId ? id : (roots.get(parent) ?? id);
      roots.set(id, root);
      const block = doc.block(root);
      const name = sourceFieldName(
        untrack(() => block?.text ?? ''),
        definitionsById(),
      );
      if (name && isCatalogueField(name)) return showFields;
      const citation = block?.citations.find(value => value.source_id === props.pageId);
      return !citation || !colors.length || colors.includes(citation.color ?? 'none');
    });
    // Authored non-catalogue fields keep their normal outline position; only source-owned groups reorder.
    const ordinary = new Set(
      shown.filter(
        id =>
          doc.outline.parentOf(id) === props.pageId &&
          untrack(() => {
            const name = sourceFieldName(doc.block(id)?.text ?? '', definitionsById());
            return !!name && !isCatalogueField(name);
          }),
      ),
    );
    if (!ordinary.size) return sourceReadingOrder(doc, shown, definitionsById());
    const groups = new Map<string, string[]>();
    for (const id of shown) {
      const root = roots.get(id)!;
      const group = groups.get(root);
      if (group) group.push(id);
      else groups.set(root, [id]);
    }
    const ordered = sourceReadingOrder(
      doc,
      shown.filter(id => !ordinary.has(roots.get(id)!)),
      definitionsById(),
    );
    const remaining = [...new Set(ordered.map(id => roots.get(id)!))];
    let index = 0;
    return [...groups].flatMap(([root, group]) => (ordinary.has(root) ? group : groups.get(remaining[index++]!)!));
  });
  const hideCandidates = mapArray(
    createMemo(() => {
      const visible = sourceVisibleIds(),
        known = definitionsById();
      return untrack(() => visible.filter(id => known.has(fieldEntryId(doc.block(id)?.text ?? '') ?? '')));
    }),
    id =>
      createMemo(
        (): HiddenFieldEntry => {
          const definition = definitionsById().get(fieldEntryId(doc.block(id)?.text ?? '') ?? '');
          let hide = fieldHide(definition);
          // A required field stays in view while it has no value, whatever its Hide setting.
          const owner = doc.block(doc.outline.parentOf(id));
          if (
            hide !== 'never' &&
            definition &&
            owner &&
            templates.requiredFor(typeKeys(owner.text, owner.manual_types)).has(definition.id)
          )
            hide = 'never';
          doc.archivedVersion();
          const values = doc.outline.children(id).filter(value => !doc.isArchived(value));
          if (!zoom() && !aliasesVisible() && aliasesInHeader(doc, id, definition?.name)) hide = 'always';
          const descendants: string[] = [];
          const start = doc.outline.indexOf(id);
          for (let index = start + 1, end = doc.outline.subtreeEnd(start); index < end; index++)
            descendants.push(doc.outline.idAt(index));
          return {
            id,
            hide,
            values: values.map(id => ({ id, blank: hide === 'when_empty' ? !doc.block(id)?.text.trim() : false })),
            descendants,
          };
        },
        undefined,
        {
          equals: (a, b) =>
            a.hide === b.hide &&
            a.values.length === b.values.length &&
            a.values.every(
              (value, index) => value.id === b.values[index]!.id && value.blank === b.values[index]!.blank,
            ) &&
            a.descendants.length === b.descendants.length &&
            a.descendants.every((id, index) => id === b.descendants[index]),
        },
      ),
  );
  // Aliases moved into the header's ALSO line are shown there, not hidden.
  const inHeader = (entry: HiddenFieldEntry) => {
    const definition = definitionsById().get(fieldEntryId(doc.block(entry.id)?.text ?? '') ?? '');
    return (
      entry.hide === 'always' && fieldHide(definition) !== 'always' && foldName(definition?.name ?? '') === 'aliases'
    );
  };
  const hiddenCounts = createMemo(() => {
    const counts = new Map<string, number>();
    const hidden = hiddenFieldEntries(
      hideCandidates()
        .map(value => value())
        .filter(entry => !inHeader(entry)),
      new Set(),
      false,
    );
    for (const id of hidden) {
      const owner = doc.outline.parentOf(id);
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    return counts;
  });
  const hiddenEntries = createMemo(
    () => {
      const retained = new Set([editing(), selected()].filter((id): id is string => !!id));
      const rows = sourceVisibleIds(),
        range = rowRange(),
        text = textRange();
      if (range)
        for (const id of selectionIds(rows, {
          anchor: { id: range.anchor, offset: 0 },
          head: { id: range.head, offset: 0 },
        }))
          retained.add(id);
      if (text) for (const id of selectionIds(rows, text)) retained.add(id);
      const revealed = revealedFields();
      return hiddenFieldEntries(
        hideCandidates()
          .map(value => value())
          .filter(entry => !revealed.has(doc.outline.parentOf(entry.id))),
        retained,
        false,
      );
    },
    undefined,
    { equals: (a, b) => a.size === b.size && [...a].every(id => b.has(id)) },
  );
  const unfoldedIds = createMemo(() => {
    const hidden = hiddenEntries(),
      visible = sourceVisibleIds();
    const omitted = new Set(hidden);
    for (const id of visible) {
      if (
        id !== zoom() &&
        doc.block(doc.outline.parentOf(id))?.task &&
        definitionsById().has(fieldEntryId(doc.block(id)?.text ?? '') ?? '')
      )
        omitted.add(id);
    }
    return visible.filter(id => {
      if (omitted.has(doc.outline.parentOf(id))) omitted.add(id);
      return !omitted.has(id);
    });
  });
  const unfoldedSet = createMemo(() => new Set(unfoldedIds()));
  // Only field entries can fold their values inline. Field entries come from structural edits (shorthand
  // conversion inserts the value), which rebuild this list; reading text untracked keeps typing out of it.
  const fieldEntries = createMemo(() => {
    const visible = unfoldedIds();
    const definitions = definitionsById();
    return definitions.size
      ? untrack(() => visible.filter(id => definitions.has(fieldEntryId(doc.block(id)?.text ?? '') ?? '')))
      : [];
  });
  // Per-entry memos keep ordinary typing from rebuilding the page's visible list.
  const fieldCandidates = mapArray(fieldEntries, id => ({
    id,
    values: createMemo(() => inlineFieldValues(doc, id, definitionsById()), undefined, {
      equals: (a, b) =>
        a === b || (!!a && !!b && a.length === b.length && a.every((value, index) => value === b[index])),
    }),
  }));
  const inlineFields = createMemo(
    () => {
      const visible = unfoldedSet();
      const retained = new Set([
        editing(),
        selected(),
        rowRange()?.anchor,
        rowRange()?.head,
        textRange()?.anchor.id,
        textRange()?.head.id,
      ]);
      const result = new Set<string>();
      for (const candidate of fieldCandidates()) {
        const values = candidate.values();
        // Hidden archived values do not keep the rest from lining up; an entry whose values are all hidden shows as empty.
        if (
          values?.some(value => visible.has(value)) &&
          values.every(value => visible.has(value) || doc.isArchived(value)) &&
          !retained.has(candidate.id)
        )
          result.add(candidate.id);
      }
      return result;
    },
    undefined,
    { equals: (a, b) => a.size === b.size && [...a].every(id => b.has(id)) },
  );
  // Compact fields share one row at rest; selecting or editing a value restores its full row identity.
  const groupedFieldContinuations = createMemo(
    () => {
      const inline = inlineFields(),
        visible = unfoldedSet(),
        known = definitionsById();
      const active = new Set([editing(), selected()]);
      const row = rowRange(),
        text = textRange();
      const ranges = [row ? [row.anchor, row.head] : null, text ? [text.anchor.id, text.head.id] : null].flatMap(
        range => {
          if (!range) return [];
          const a = doc.outline.indexOf(range[0]!),
            b = doc.outline.indexOf(range[1]!);
          return a < 0 || b < 0 ? [] : [[Math.min(a, b), Math.max(a, b)]];
        },
      );
      const omitted = new Set<string>();
      for (const candidate of fieldCandidates()) {
        if (
          !inline.has(candidate.id) ||
          !['attribute', 'citation'].includes(
            fieldRole(known.get(fieldEntryId(doc.block(candidate.id)?.text ?? '') ?? '')),
          )
        )
          continue;
        const values = candidate.values()?.filter(id => visible.has(id) && !doc.isArchived(id)) ?? [];
        if (
          values.length < 2 ||
          values.some(id => {
            const block = doc.block(id),
              index = doc.outline.indexOf(id);
            return (
              active.has(id) ||
              ranges.some(([a, b]) => index >= a! && index <= b!) ||
              !block ||
              block.task ||
              block.project ||
              block.question ||
              block.assessment ||
              block.position ||
              block.relation ||
              block.quote ||
              block.image ||
              block.occlusion ||
              block.keptCopy ||
              block.manual_types.length ||
              block.citations.length ||
              block.templateCards
            );
          })
        )
          continue;
        for (const id of values.slice(1)) omitted.add(id);
      }
      return omitted;
    },
    undefined,
    { equals: (a, b) => a.size === b.size && [...a].every(id => b.has(id)) },
  );
  // Read and Outline omit exactly the same continuation values.
  const readView = createMemo(() => {
    const view = register(),
      inline = inlineFields(),
      continuations = groupedFieldContinuations();
    return inline.size
      ? {
          ...view,
          opening: view.opening.filter(id => !inline.has(id) && !continuations.has(id)),
          remaining: view.remaining.filter(id => !inline.has(id) && !continuations.has(id)),
        }
      : view;
  });
  // Selection does not re-walk the outline just to expand a compact value list.
  const outlinedRows = createMemo(() => {
    const inline = inlineFields(),
      visible = unfoldedIds();
    return fieldBedRows(
      doc,
      inline.size ? visible.filter(id => !inline.has(id)) : visible,
      definitionsById(),
      zoom() ?? props.pageId,
    );
  });
  const ids = createMemo(() => {
    const continuations = groupedFieldContinuations();
    if (reading()) {
      const view = readView();
      return [
        ...view.opening,
        ...(view.sectionId ? [view.sectionId] : []),
        ...view.slips.flatMap(slip => readingSlipRows(doc, slip, readDisclosures())),
        ...view.disagreements.flatMap(group => readingDisagreementRows(doc, group, readDisclosures())),
        ...view.remaining,
      ].filter(id => !continuations.has(id));
    }
    return outlinedRows().filter(id => !continuations.has(id));
  });
  const indices = createMemo(() => new Map(ids().map((id, index) => [id, index])));
  const baseDepth = createMemo(() => (zoom() ? doc.outline.depth(zoom()!) : 0));
  const positionSource = (id: string) => sharedPositionSource(doc, id, fieldId => definitionsById().get(fieldId)?.name);
  const localPositions = createMemo(() => localPositionCount(doc));
  const positionZoom = createMemo(() => {
    const id = zoom();
    return id && doc.block(id)?.position ? id : null;
  });
  const dossierFields = createMemo(() =>
    positionZoom() ? positionFields(doc, positionZoom()!, id => definitionsById().get(id)?.name) : [],
  );
  const [branches] = createResource(
    () =>
      !creatingRoot() && doc.root()?.question ? ([props.pageId, props.workshop.changed('inquiry')] as const) : false,
    ([parent]) => props.workshop.api.questions({ parent }),
  );
  // Sources cited or named by positions on this page, in order of first appearance, give the sigla shown in
  // the margin. A source page's own highlights need no mark.
  const referenceSources = createCitationSources(props.workshop, () => {
    const texts: string[] = [];
    (doc.outline as OutlineIndex).each(0, doc.outline.size(), row => {
      const text = doc.block(row.id)?.text;
      if (text) texts.push(text);
    });
    return texts;
  });
  const citedSources = createMemo(
    () => {
      const seen: string[] = [];
      const add = (id: string | null | undefined) => {
        if (id && id !== props.pageId && !seen.includes(id)) seen.push(id);
      };
      (doc.outline as OutlineIndex).each(0, doc.outline.size(), row => {
        const block = doc.block(row.id);
        if (block?.position) add(positionSource(row.id));
        for (const citation of block?.citations ?? []) add(citation.source_id);
        for (const token of textTokens(block?.text ?? ''))
          if (hasCitationDetail(token) && referenceSources()?.has(token.id!)) add(token.id!);
      });
      return seen;
    },
    undefined,
    { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) },
  );
  const siglumRecords = createCitedSources(props.workshop, citedSources);
  const sigla = createMemo(() => citedSigla(siglumRecords()));
  /** Each distinct source on the page once, for the apparatus key. */
  const siglumSources = createMemo(() => [
    ...new Set(siglumRecords().flatMap(row => (row.source ? [row.source.block_id] : []))),
  ]);
  const [sourceHighlights] = createResource(
    () =>
      !creatingRoot() && doc.root()?.source && !zoom()
        ? ([props.pageId, props.workshop.changed('library'), live()] as const)
        : false,
    ([source_id]) => props.workshop.api.highlights({ source_id, limit: 100000 }),
  );
  const [sourceHeaderReady, setSourceHeaderReady] = createSignal(false);
  const sourceApparatusReady = () => sourceHeaderReady() && !!(fields.error || fields.latest);
  // Top-level notes reveal their kinds and aliases with the title and opening rows.
  const isNote = () =>
    !zoom() && doc.root()?.kind === 'page' && !doc.root()?.source && doc.root()?.text.toLowerCase() !== 'fields';
  const [noteKinds] = createResource(
    () => (!creatingRoot() && isNote() ? ([props.pageId, props.workshop.changed('pages'), live()] as const) : false),
    ([id]) => props.workshop.api.noteKinds(id),
  );
  createEffect(() => {
    if (isNote()) props.onNoteKinds?.(noteKinds.error ? undefined : noteKinds.latest);
  });
  // A behavior tag leads the title as its glyph. Any other title tag follows it as a pill, unless the eyebrow already names that kind.
  const titleGlyphs = createMemo(() =>
    titleTags().filter(token => isCapabilityTag(tagLabel(token, id => props.workshop.lookup(id)))),
  );
  const titlePills = createMemo(() =>
    titleTags().filter(
      token =>
        !titleGlyphs().includes(token) && !(isNote() && !noteKinds.error && eyebrowNamesTag(noteKinds.latest, token)),
    ),
  );
  // Mount the designed structure for measurement, but reveal it and its portaled dock together.
  // Keep settled resources visible during background refreshes, and paint nothing before the first load:
  // the title's "Loading…" placeholder otherwise flashes for a frame on every page open.
  // Once revealed, reconnecting metadata cannot hide a cached editable page.
  // An explicit editing destination already has local text. Catalog metadata must not hide its live caret.
  const [pageRevealed, setPageRevealed] = createSignal(false);
  const pageReady = () =>
    pageRevealed() ||
    (doc.status() !== 'loading' &&
      (creatingRoot() ||
        props.workshop.connection() === 'offline' ||
        !!(initial.edit && zoom() && initial.caret && doc.block(initial.caret.id)) ||
        ((!doc.root()?.source ||
          (sourceApparatusReady() && (!!zoom() || !!(sourceHighlights.error || sourceHighlights())))) &&
          (!isNote() || (!!(fields.error || fields.latest) && !!(noteKinds.error || noteKinds.latest))))));
  createEffect(() => {
    if (pageReady()) setPageRevealed(true);
  });
  const filedElsewhere = createMemo(() =>
    (sourceHighlights.error ? [] : (sourceHighlights()?.rows ?? []))
      .filter(
        row =>
          row.block.page.id !== props.pageId &&
          (!sourceColors().length || sourceColors().includes(row.color ?? 'none')),
      )
      .sort((a, b) => a.citation.ordinal - b.citation.ordinal || a.citation.start.offset - b.citation.start.offset),
  );
  const sourceDetails = createMemo(() => {
    const fields = new Map<string, string>();
    // The first highlight under each chapter of the contents, in reading order, carries that chapter's title.
    const chapters = new Map<string, string>();
    if (!doc.root()?.source || zoom()) return { fields, chapters };
    const counts = new Map<string, number>();
    for (const row of sourceHighlights.error ? [] : (sourceHighlights()?.rows ?? [])) {
      const title = row.citation.chapter_title;
      if (
        row.block.page.id === props.pageId &&
        title &&
        (!sourceColors().length || sourceColors().includes(row.color ?? 'none'))
      )
        counts.set(title, (counts.get(title) ?? 0) + 1);
    }
    let chapter: string | null | undefined;
    for (const id of unfoldedIds().filter(id => doc.outline.parentOf(id) === props.pageId)) {
      const block = doc.block(id);
      if (!block || (block.archived && !showArchived())) continue;
      const name = sourceFieldName(block.text, definitionsById());
      const citation = name ? undefined : block.citations.find(value => value.source_id === props.pageId);
      if (name && isCatalogueField(name)) fields.set(id, name);
      else if (citation) {
        const title = citation.chapter_title ?? null;
        if (sourceGrouped() && title && title !== chapter)
          chapters.set(id, `${contentsTitle(title)}${counts.has(title) ? ` · ${counts.get(title)}` : ''}`);
        chapter = title;
      }
    }
    return { fields, chapters };
  });
  function report() {
    if (restoring || disposed || props.projection === 'compare' || (reading() && pendingReadAnchor())) return;
    // A page left at its top reopens at its top: a row anchor would keep that row's offset under a page head whose
    // height differs by width and by what its tiles load, and scroll the head away.
    const top = !reading() && scroll && scroll.scrollTop < 1;
    props.onViewChange({
      ...props.view,
      reveal: undefined,
      zoom: zoom(),
      folds: [...folds()],
      showArchived: showArchived(),
      depth: depth(),
      sourceFieldsVisible: sourceFieldsVisible(),
      readDisclosures: [...readDisclosures()],
      caret: caret(),
      scroll: top ? null : currentAnchor(),
    });
  }
  function scheduleReport() {
    cancelAnimationFrame(reportingFrame);
    reportingFrame = requestAnimationFrame(report);
  }
  const viewportController = createOutlineViewport({
    pageId: props.pageId,
    doc,
    workshop: props.workshop,
    active: () => props.active,
    reading,
    ids,
    indices,
    folds,
    setFolds,
    editing,
    selected,
    composition,
    capabilitiesPopupId: () => capabilities.popup()?.id,
    viewport,
    editingBarVisible,
    suppressCaretScroll: () => suppressCaretScroll,
    focusEpoch: () => focusEpoch,
    disposed: () => disposed,
    initialReveal: initial.reveal,
    initialScroll: initial.scroll,
    hosts,
    scroll: () => scroll,
    list: () => list,
    heading: () => heading,
    editingBar: () => editingBar,
    editor: () => editor,
    rowAnchor,
    readingAnchor,
    rowFocus: id => rowFocus(id),
    restoreFocus: () => restoreFocus(),
    report,
    scheduleReport,
  });
  const {
    margin,
    setMargin,
    pendingReadAnchor,
    setPendingReadAnchor,
    foldMotion,
    foldGroups,
    sectionName,
    longPage,
    scrolledAway,
    virtualizer,
    virtualItems,
    listHeight,
    currentAnchor,
    scrolled,
    cancelScroll,
    settleScroll,
    restoreAnchor,
    restoreInitialAnchor,
    highlightReading,
    anchored,
    finishFoldMotion,
    fold,
  } = viewportController;

  function measure(label: 'typing' | 'structural', change: () => void) {
    const start = performance.now();
    change();
    const handler = performance.now() - start;
    document.dispatchEvent(new CustomEvent('outline-handler', { detail: { kind: label, handler, start } }));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.dispatchEvent(
          new CustomEvent('outline-latency', {
            detail: { kind: label, handler, start, frame: performance.now() - start },
          }),
        );
      }),
    );
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
    if (!request && same && host.contains(editor.view.dom)) {
      editor.sync(block.text);
      followText(id);
      return;
    }
    const offset = request?.offset ?? (caret()?.id === id ? caret()!.offset : 0);
    const popupFocused = document.activeElement?.closest('[role="dialog"], [role="menu"], [role="listbox"]');
    editor.mount(
      host,
      id,
      block.text,
      offset,
      request?.insert ?? !props.vim,
      !!request?.focus && props.active && !popupFocused && !renaming(),
    );
    if (same) followText(id);
    // Publishing the inserted row's height and revealing its caret must finish before the same paint.
    if (viewportController.hasAnchorFrame()) settleScroll();
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
      const slip = register().slips.find(
        slip =>
          slip.passages.includes(id) || slip.facts.some(field => doc.outline.children(field.entryId).includes(id)),
      );
      if (slip)
        setReadDisclosures(
          previous => new Set([...previous, `${slip.id}:${slip.passages.includes(id) ? 'prose' : 'facts'}`]),
        );
    }
    // A holder-scoped answer may not belong to the Read projection. Reveal its actual editor, never an unrelated survivor.
    if (
      reading() &&
      !indices().has(id) &&
      definitionsById().has(fieldEntryId(doc.block(doc.outline.parentOf(id))?.text ?? '') ?? '')
    )
      props.onProjection?.('outline');
    // Settle a deferred closing fold before unfolding, so its completion cannot hide the target again.
    finishFoldMotion();
    const ancestors: string[] = [];
    for (
      let child = id, parent = doc.outline.parentOf(id);
      parent !== child;
      child = parent, parent = doc.outline.parentOf(parent)
    ) {
      if (folds().has(parent)) ancestors.push(parent);
    }
    if (ancestors.length)
      setFolds(previous => {
        const next = new Set(previous);
        for (const parent of ancestors) next.delete(parent);
        return next;
      });
    setDepth(editingDepth(doc, id, zoom(), folds(), showArchived(), depthFilter()));
  }
  function restoreFocus() {
    if (disposed || !props.active || composition() || renaming()) return;
    const id = editing();
    if (id && indices().has(id) && editor?.id === id && editor.view.dom.isConnected) {
      if (suppressCaretScroll) editor.focusHeld();
      else editor.view.focus();
    } else scroll.focus({ preventScroll: true });
  }
  function editAt(id: string, offset = 0, insert = !props.vim, reveal = true, activate = true, focus = true) {
    if (disposed || composition()) return;
    if (reveal) {
      suppressCaretScroll = false;
      holdOpeningScroll = false;
    }
    revealRow(id);
    if (!indices().has(id)) {
      selectSurvivor(id, ids());
      return;
    }
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
    focusRequest = { id, offset, insert, epoch: ++focusEpoch, focus };
    if (reveal) viewportController.requestReveal(id, focusEpoch, true);
    setEditing(id);
    mountEditor(id);
    if (focusRequest) queueMicrotask(() => mountEditor(id));
    scheduleReport();
  }
  function rowFocus(id: string, extend = false, keepValue = false) {
    if (disposed || composition()) return;
    suppressCaretScroll = false;
    holdOpeningScroll = false;
    if (!indices().has(id)) {
      selectSurvivor(id, ids());
      return;
    }
    const previous = editing();
    if (previous && doc.block(previous) && commitFieldEntry(previous)) return;
    if (previous && !(keepValue && previous === id)) {
      const replacement = pruneEmptyValue(previous);
      if (replacement && id === previous) id = replacement;
    }
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
    viewportController.requestReveal(id, focusEpoch, false);
    scheduleReport();
  }
  function apply(intent: Edit, keepEditing = editing() !== null): EditResult | undefined {
    if (disposed || composition()) return undefined;
    if (
      intent.kind === 'text' ||
      intent.kind === 'replaceRange' ||
      intent.kind === 'split' ||
      intent.kind === 'merge' ||
      intent.kind === 'pasteBlocks' ||
      intent.kind === 'pasteRows'
    )
      hints.typed();
    const rearrange =
      intent.kind === 'indent' || intent.kind === 'outdent' || intent.kind === 'move' || intent.kind === 'moveTo';
    const keepSelection =
      rearrange ||
      intent.kind === 'bulkTask' ||
      intent.kind === 'heading' ||
      intent.kind === 'addType' ||
      intent.kind === 'removeType';
    if (intent.kind === 'indent' || intent.kind === 'outdent' || intent.kind === 'move')
      intent = { ...intent, zoomRoot: zoom() };
    const before = ids();
    const previousCaret = caret();
    const selection = rowRange() ?? (selected() && !editing() ? { anchor: selected()!, head: selected()! } : undefined);
    const epoch = focusEpoch;
    let result: EditResult | undefined;
    focusRestoresPending++;
    viewportController.markSlideRemoval(intent.kind === 'delete');
    measure('structural', () =>
      anchored(() => {
        result = doc.edit(intent, previousCaret ? { ...previousCaret, selection } : null);
      }),
    );
    if (!result || !result.ok) {
      viewportController.markSlideRemoval(false);
      focusRestoresPending--;
      setMessage(result && !result.ok ? result.reason : 'The edit could not be applied.');
      return result;
    }
    setMessage('');
    if (
      reading() &&
      (rearrange ||
        ['split', 'insert', 'merge', 'pasteBlocks', 'pasteRows'].includes(intent.kind) ||
        (intent.kind === 'replaceRange' && intent.mode !== 'text'))
    )
      props.onProjection?.('outline');
    setTextRange(null);
    if (!keepSelection) setRowRange(null);
    const next = result.caret;
    if (next && keepEditing) revealRow(next.id);
    if (next)
      queueMicrotask(() => {
        try {
          if (disposed || !props.active || focusEpoch !== epoch) return;
          if (!indices().has(next.id)) selectSurvivor(next.id, before);
          else if (keepEditing) editAt(next.id, next.offset, true, true, false);
          else if (rearrange) scroll.focus({ preventScroll: true });
          else rowFocus(next.id);
        } finally {
          focusRestoresPending--;
        }
      });
    else {
      focusRestoresPending--;
      if (selected() && !indices().has(selected()!)) selectSurvivor(selected()!, before);
    }
    scheduleReport();
    return result;
  }
  function undo(redo = false) {
    if (disposed || composition()) return;
    if (!redo && pendingUndo) {
      void pendingUndo.run();
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
    if (result)
      queueMicrotask(() => {
        try {
          if (disposed || !props.active || focusEpoch !== epoch) return;
          const target = result.range?.head ?? result;
          if (result.selection) {
            const anchor = result.selection.anchor,
              head = result.selection.head;
            if (!indices().has(anchor) || !indices().has(head)) {
              selectSurvivor(head, before);
              return;
            }
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
          else if (
            hasValueEditor(
              definitionsById().get(fieldEntryId(doc.block(doc.outline.parentOf(target.id))?.text ?? '') ?? ''),
              doc.block(target.id)?.text ?? '',
              contextDate(),
            )
          ) {
            closeValueEditor();
            rowFocus(target.id);
            setCaret({ id: target.id, offset: target.offset });
          } else {
            editAt(target.id, target.offset, !props.vim, true, false);
            if (result.range)
              queueMicrotask(() => {
                if (!disposed && props.active && editing() === target.id) restoreSelection(result.range!);
              });
          }
        } finally {
          focusRestoresPending--;
        }
      });
  }
  function replaceSelection(
    text: string,
    mode: 'text' | 'paste' | 'split',
    range = activeRange(),
    selectionBefore?: TextRange,
  ) {
    if (!range) return;
    const visible = selectionIds(ids(), range);
    const parent = doc.outline.parentOf(range.anchor.id);
    const fieldEntry =
      mode === 'split' && definitionsById().has(fieldEntryId(doc.block(parent)?.text ?? '') ?? '') ? parent : null;
    apply(
      {
        kind: 'replaceRange',
        range,
        selectionBefore,
        between: visible.slice(1, -1),
        text,
        mode,
        zoomRoot: zoom(),
        fieldEntry,
      },
      true,
    );
  }
  function deleteTextRange() {
    if (textRange()) replaceSelection('', 'text');
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
    if (selected() && !visible.has(selected()!)) {
      setSelected(null);
      setCaret(null);
    }
    setRowRange(null);
    setTextRange(null);
    report();
    scheduleReport();
  }
  const depthReason = () =>
    doc.root()?.kind !== 'page'
      ? 'Only titled atoms have depth.'
      : props.projection && props.projection !== 'outline'
        ? 'Choose Outline to change depth.'
        : zoom()
          ? 'Zoom out to change depth.'
          : undefined;
  const stepDepth = (delta: 1 | -1) => {
    const next = depthStops[depthStops.indexOf(depth()) + delta];
    if (next) setStop(next);
  };
  const depthTitles: Record<Depth, string> = {
    gloss: 'Show the gloss only',
    opening: 'Show the opening',
    perspectives: 'Show perspectives',
    full: 'Show the full atom',
  };
  const headerActions = createOutlineHeaderActions({
    pageId: props.pageId,
    doc,
    workshop: props.workshop,
    active: () => props.active,
    vim: () => props.vim,
    onVimMode: props.onVimMode,
    disposed: () => disposed,
    focusEpoch: () => focusEpoch,
    bumpFocusEpoch: () => ++focusEpoch,
    clearFocusRequest: () => {
      focusRequest = null;
    },
    clearCompletion: () => setCompletion(null),
    setEditing,
    setTextRange,
    setMessage,
    caret,
    glossId,
    zoom,
    zoomTo,
    depth,
    setStop,
    setAliasesVisible,
    setFolds,
    definitionsByName,
    onCreatedField: field =>
      setCreatedFields(previous =>
        previous.some(existing => existing.id === field.id) ? previous : [...previous, field],
      ),
    editAt,
    scroll: () => scroll,
    scheduleReport,
  });
  const {
    renaming,
    title,
    setTitle,
    mergeTarget,
    setMergeTarget,
    titleCollision,
    rename,
    closeTitle,
    commitTitle,
    abandonTitle,
    addGloss,
    addAlias,
  } = headerActions;

  // Factories share the pane's owner. Keep signals callable and late-mounted state behind getters;
  // forwarding callbacks connect factories without reading another factory before it is initialized.
  const context: OutlineContext = {
    contextDate,
    editing,
    textRange,
    composition,
    caret,
    get editor() {
      return editor;
    },
    doc,
    capabilities,
    setCaret,
    scheduleReport,
    setMessage,
    showNotice,
    openMoveToPage: () => openMoveToPage(),
    openBulkDate: (targets, field, anchor) => {
      if (targets.length) setBulkDate({ ids: [...targets], field, anchor });
    },
    openRelation: (id, kind, anchor) => openRelation(id, kind, anchor),
    fileAll: (ids, anchor) => fileAll(ids, anchor),
    positionReason: id => positionReason(id),
    placeReason: id => placeReason(id),
    usePlace: id => usePlace(id),
    get disposed() {
      return disposed;
    },
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
    get commandDefinitions() {
      return commandDefinitions;
    },
    fieldMenu: (id, anchor) => fieldMenu(id, anchor),
    pickField: (owner, anchor) => fieldSheet.pick(owner, anchor),
    openViewEmbed: id => openViewEmbed(id),
    openPlanning: (id, kind) => openPlanning(id, kind),
    priorityMenu: id => priorityMenu(id),
    openProject: id => openProject(id),
    investigationItems: (id, manager) => investigationItems(id, manager),
    markRelation: (id, kind, text) => markRelation(id, kind, text),
    relationMenu: (id, add, text) => relationMenu(id, add, text),
    apply,
    chooseImage: (id, replace) => images.chooseImage(id, replace),
    openImage: id => images.openImage(id),
    editOcclusion: id => images.editOcclusion(id),
    uploadImages: (files, targetId) => images.uploadImages(files, targetId),
    zoomTo,
    copy: text => copy(text),
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
    get heading() {
      return heading;
    },
    adjacent: (direction, extend) => adjacent(direction, extend),
    horizontal: direction => horizontal(direction),
    ids,
    rowFocus,
    split: view => split(view),
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
    get setCompletionIndex() {
      return setCompletionIndex;
    },
    get setCompletion() {
      return setCompletion;
    },
    rewriteEditing: (id, next) => rewriteEditing(id, next),
    folds,
    inlineFields,
    setSelected,
    deleteTextRange,
    setTextRange,
    forgetReferenceSpace: event => forgetReferenceSpace(event),
    slashKey: event => slashKey(event),
    dateKey: event => dateKey(event),
    popupKey: event => popupKey(event),
    leaderMenu: id => leaderMenu(id),
    makeCloze: () => makeCloze(),
    openTable: beside => openTable(beside),
    rowRange,
    statusMenu: id => statusMenu(id),
    get scroll() {
      return scroll;
    },
    clearSelection,
    restoreSelection,
    selectedIds,
    get compositionSelection() {
      return selection.hasCompositionSelection;
    },
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
    rowContext: (id, source) => rowContext(id, source),
    holderMenu: (id, anchor) => holderMenu(id, anchor),
    pointerStart: (event, id, element) => pointerStart(event, id, element),
    attach,
    referenceMenu: (id, anchor) => referenceMenu(id, anchor),
    selectedOffsets: id => selectedOffsets(id),
    conflicts,
    editedConflicts,
    setEditedConflicts,
  };
  const { openRelation, fileAll, positionReason, placeReason, usePlace, RelationPopups } = createRelationActions(
    context,
    async holderId => {
      // The recipe offers only defined fields, so Tab from the Gist reaches Work only once work exists.
      const field =
        definitionsByName().get('gist') ?? (await ensureField(props.workshop, 'gist', 'text', 'standfirst'));
      const work = definitionsByName().get('work') ?? (await ensureField(props.workshop, 'work', 'instance'));
      setCreatedFields(previous => [
        ...previous,
        ...[field, work].filter(created => !previous.some(existing => existing.id === created.id)),
      ]);
      const last = register().slips.at(-1)?.id;
      const parentId = last ? doc.outline.parentOf(last) : props.pageId;
      const result = doc.edit(
        {
          kind: 'addReading',
          parentId,
          after: last ?? doc.outline.children(parentId).at(-1) ?? null,
          holderId,
          gistFieldId: field.id,
        },
        caret(),
      );
      if (!result.ok) throw new Error(result.reason);
      await doc.flush();
      if (result.caret) requestAnimationFrame(() => editAt(result.caret!.id, 0, true));
    },
  );
  const { openViewEmbed, ViewEmbedPopups } = createViewEmbedActions(context);
  const { openMoveToPage, MoveToPagePopup } = createMoveToPage(context);
  const {
    setCompletion,
    setCompletionIndex,
    offerValue,
    openValueEditor,
    closeValueEditor,
    valueEditorId,
    pendingReference,
    pendingType,
    syncCompletions,
    updateCompletion,
    updateTriggers,
    taskPrefix,
    rewriteEditing,
    referenceInput,
    forgetReferenceSpace,
    slashKey,
    dateKey,
    popupKey,
    CompletionPopups,
  } = createOutlineCompletions(
    context,
    id => {
      fieldSheet.start(id);
    },
    (id, backward) => fieldSheet.advance(id, backward),
  );
  const {
    openTable,
    investigationItems,
    markRelation,
    relationMenu,
    commandDefinitions,
    unregister,
    blockMenu,
    bulkMenu,
    rowContext,
    holderMenu,
    fieldMenu,
    statusMenu,
    priorityMenu,
    openPlanning,
    openProject,
    leaderMenu,
    makeCloze,
    referenceMenu,
    copy,
  } = createOutlineCommands(context);
  const { horizontal, adjacent, split, editorKey, structuralKey, pruneEmptyValue, resetRowKey, resetVerticalGoal } =
    createOutlineKeyboard(context, (event, id) => fieldSheet.key(event, id));
  const { selectedOffsets, pointerStart, pointerMove, pointerEnd, clipboard, paste, beforeInput } =
    createOutlineInteractions(context);
  const fieldSheet = createFieldSheet(context, {
    offerValue,
    onField: field =>
      setCreatedFields(previous =>
        previous.some(existing => existing.id === field.id) ? previous : [...previous, field],
      ),
    controlledId: valueEditorId,
    closeControlled: closeValueEditor,
    hiddenCounts,
    revealed: revealedFields,
    reveal: owner =>
      setRevealedFields(previous => {
        const next = new Set(previous);
        next.has(owner) ? next.delete(owner) : next.add(owner);
        return next;
      }),
  });
  const drag = createOutlineDrag(context);
  const images = createOutlineImages(context);
  const {
    related,
    relatedError,
    relatedLoading,
    apparatus,
    holders,
    holderRelations,
    linkedPages,
    isCollection,
    CollectionSources,
    Related,
    Backlinks,
    UnlinkedMentions,
    mentionsAvailable,
    ReferenceCount,
    RowRelations,
  } = createOutlineRelated(context);
  const holderBoundary = createMemo(() =>
    !zoom() && related()?.heldReadings.length
      ? ids().find(id => doc.outline.parentOf(id) === props.pageId && !!doc.block(id)?.heading)
      : undefined,
  );
  const journalLayout = createJournalLayout(doc, props.workshop, () => !zoom());
  const { Row, TaskSummary, QuestionSummary } = createOutlineRows(
    context,
    fieldSheet,
    drag,
    ReferenceCount,
    RowRelations,
    openValueEditor,
    row => (
      <Show when={holderBoundary() === row.id}>
        <HeldReadings rows={related()?.heldReadings ?? []} workshop={props.workshop} onOpen={props.onOpen} />
      </Show>
    ),
    DiscoveryHints,
    journalLayout,
  );
  const emptyRootBlock = createMemo(() => {
    if (zoom() || doc.root()?.kind !== 'page' || doc.root()?.source || doc.outline.size() !== 1) return undefined;
    const id = doc.outline.idAt(0),
      block = doc.block(id);
    return block &&
      !doc.isArchived(id) &&
      doc.outline.parentOf(id) === props.pageId &&
      !block.text &&
      !block.heading &&
      !block.task &&
      !block.position &&
      !block.relation &&
      !block.question &&
      !block.assessment &&
      !block.quote &&
      !block.image &&
      !block.citations.length &&
      !block.manual_types.length
      ? id
      : undefined;
  });
  const { CapabilityPopups } = createCapabilityPopups(context);
  const projectSummary = createProjectSummary({
    doc,
    workshop: props.workshop,
    date: contextDate,
    onOpen: props.onOpen,
    onEdit: anchor => capabilities.open(props.pageId, 'project', anchor),
  });
  createEffect(
    on(
      () => props.projection,
      () => {
        if (props.projection !== 'read') setPendingReadAnchor(null);
        if (!scroll || restoring || props.projection === 'compare') return;
        const anchor = props.view.scroll;
        if (anchor) revealRow(anchor.id);
        requestAnimationFrame(() => {
          if (disposed) return;
          if (!reading() && anchor && indices().has(anchor.id))
            virtualizer.scrollToIndex(indices().get(anchor.id)!, { align: 'start' });
          restoreAnchor(anchor);
          if (editing()) mountEditor(editing()!);
          scrolled();
        });
      },
      { defer: true },
    ),
  );

  onMount(() => {
    const copy = (event: ClipboardEvent) => clipboard(event);
    const cut = (event: ClipboardEvent) => clipboard(event, true);
    scroll.addEventListener('copy', copy, true);
    scroll.addEventListener('cut', cut, true);
    const clearOutsideRows = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!scroll.contains(target) || target.closest('[data-block-id], button, input, [role="menu"], [role="dialog"]'))
        return;
      const belowRows = (target === scroll || target === list) && event.clientY >= list.getBoundingClientRect().bottom;
      if (event.button !== 0 || !belowRows || doc.status() !== 'ready' || depthFilter() !== undefined) {
        clearSelection();
        return;
      }
      event.preventDefault();
      setTextRange(null);
      props.onActivate();
      const parentId = zoom() ?? props.pageId;
      const last = doc.outline.children(parentId).at(-1);
      if (last && doc.block(last)?.text === '' && !doc.isArchived(last) && doc.outline.children(last).length === 0)
        editAt(last, 0, true);
      else apply({ kind: 'insert', parentId, after: last ?? null }, true);
    };
    scroll.addEventListener('mousedown', clearOutsideRows);
    onCleanup(() => scroll.removeEventListener('mousedown', clearOutsideRows));
    document.addEventListener('pointerdown', resetVerticalGoal, true);
    document.addEventListener('pointerdown', abandonTitle, true);
    onCleanup(() => {
      document.removeEventListener('pointerdown', resetVerticalGoal, true);
      document.removeEventListener('pointerdown', abandonTitle, true);
    });
    scroll.addEventListener('paste', paste, true);
    scroll.addEventListener('beforeinput', beforeInput, true);
    onCleanup(() => {
      scroll.removeEventListener('copy', copy, true);
      scroll.removeEventListener('cut', cut, true);
      scroll.removeEventListener('paste', paste, true);
      scroll.removeEventListener('beforeinput', beforeInput, true);
    });
    const releaseCaretHold = () => {
      suppressCaretScroll = false;
      holdOpeningScroll = false;
    };
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const)
      scroll.addEventListener(type, releaseCaretHold, { capture: true, passive: true });
    onCleanup(() => {
      for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const)
        scroll.removeEventListener(type, releaseCaretHold, { capture: true });
    });
    const keepOpeningScroll = () => {
      if (holdOpeningScroll && scroll.scrollTop !== 0) scroll.scrollTop = 0;
    };
    scroll.addEventListener('scroll', keepOpeningScroll);
    onCleanup(() => scroll.removeEventListener('scroll', keepOpeningScroll));
    editor = new PaneEditor({
      suppressScroll: () => suppressCaretScroll,
      rewrite: syncCompletions,
      key: editorKey,
      input: referenceInput,
      label: id => {
        const target = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id) ? props.workshop.lookup(id)() : undefined;
        return target ? plainText(target.text, reference => props.workshop.lookup(reference)) : undefined;
      },
      isSource: id => !!referenceSources()?.has(id),
      tag: (title, id) => {
        const target = id ? props.workshop.lookup(id)() : undefined;
        const name = target?.text || title || id || '';
        const kind = tagRegistry.error
          ? undefined
          : tagRegistry()?.kinds.find(
              kind => kind.tag && (id ? kind.type_id === id : foldName(kind.name) === foldName(title)),
            );
        return { name, icon: kind ? noteKindIcon(kind) : undefined, unresolved: !!id && target === null };
      },
      nameMatches: name => (editingNames.error ? undefined : editingNames()?.get(foldName(name))),
      referenceMenu: (token, anchor) => {
        const matches = editingNames.error ? undefined : editingNames()?.get(foldName(token.id!));
        if (editor?.id && matches && matches.length > 1)
          setMenu({
            anchor,
            label: 'Choose an atom',
            header: (
              <div class="menu-section">
                “{token.id}” names {matches.length} atoms
              </div>
            ),
            items: nameMenuItems(props.workshop, editor.id, token, matches, setMessage),
          });
      },
      openReference: (token, beside) => {
        void (async () => {
          if (isViewReference(token)) {
            const view = (await props.workshop.api.views()).find(view => view.id === token.id);
            if (view && !disposed)
              props.onOpen({ kind: 'table', typeId: view.query.type, viewId: view.id, query: view.query }, beside);
            return;
          }
          if (token.kind === 'tag') {
            const id = token.id ?? (await props.workshop.pageByTitle(token.value, false));
            if (id && !disposed) props.onOpen({ kind: 'page', pageId: id }, beside);
            return;
          }
          const matches = isStableReference(token) ? null : await resolveName(props.workshop, token.id!);
          const block = isStableReference(token)
            ? (props.workshop.lookup(token.id!)() ?? (await props.workshop.api.block(token.id!)))
            : matches?.length === 1
              ? matches[0]!.page
              : undefined;
          if (block && !disposed)
            props.onOpen(
              { kind: 'page', pageId: block.page_id, blockId: block.kind === 'block' ? block.id : undefined },
              beside,
            );
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
          if (replacement && editing() === id) {
            setEditing(null);
            setSelected(replacement);
            setCaret({ id: replacement, offset: 0 });
          }
        });
      },
      text: (text, at, group) =>
        measure('typing', () => {
          suppressCaretScroll = false;
          holdOpeningScroll = false;
          resetVerticalGoal();
          if (selection.hasCompositionSelection) return;
          hints.typed();
          const heading = composition() ? null : headingPrefix(doc.block(at.id)?.text ?? '', text, at.offset);
          const task = heading ? null : taskPrefix(text, at);
          if (heading) {
            const result = doc.edit(
              { kind: 'text', id: at.id, text: heading.text, heading: heading.heading, caret: heading.caret },
              caret(),
            );
            if (!result.ok) {
              setMessage(result.reason);
              return;
            }
            queueMicrotask(() => {
              if (editor?.id === at.id) {
                editor.sync(heading.text);
                editor.view.dispatch({ selection: { anchor: heading.caret } });
              }
            });
            text = heading.text;
            at = { id: at.id, offset: heading.caret };
            setCaret(at);
          } else if (task === false) return;
          else if (task) {
            text = task.text;
            at = task.caret;
          } else {
            const result = doc.edit({ kind: 'text', id: at.id, text, caret: at.offset, group }, caret());
            if (!result.ok) setMessage(result.reason);
          }
          // Text left after an input rule still offers its completions, so a date typed with the prefix plans the task.
          doc.holdTag(at.id, pendingType(at.id) || !!typeTokenAt(text, at.offset));
          updateCompletion(text, at, true);
          updateTriggers(text, at);
          viewportController.requestReveal(at.id, focusEpoch, true);
        }),
      selection: at => {
        if (selection.hasCompositionSelection || (textRange() && textRange()!.head.id !== at.id)) return;
        focusEpoch++;
        setCaret(at);
        setTextRange(previous =>
          previous && previous.head.id === at.id ? { anchor: previous.anchor, head: at } : previous,
        );
        // A navigation restore reports the caret but must not reveal it. Create-and-edit and a later move still do.
        if (!suppressCaretScroll) viewportController.requestReveal(at.id, focusEpoch, true);
        if (editor) {
          const text = editor.view.state.doc.toString();
          doc.holdTag(at.id, pendingType(at.id) || !!typeTokenAt(text, at.offset));
          updateCompletion(text, at, false);
          updateTriggers(text, at);
        }
        scheduleReport();
      },
      composition: composing,
      mode: mode => {
        if (editing()) props.onVimMode(props.vim ? mode : null);
      },
    });
    editor.configure(props.vim);
    editor.configureFields(
      id => definitionsById().get(id)?.name,
      name => definitionsByName().get(name.toLowerCase())?.kind,
    );
    const observer = new ResizeObserver(() => {
      setMargin(list.offsetTop);
      scrolled();
    });
    observer.observe(scroll.querySelector('.outline-heading')!);
    observer.observe(list);
    setMargin(list.offsetTop);
    document.addEventListener('mousemove', pointerMove);
    document.addEventListener('mouseup', pointerEnd);
    onCleanup(() => {
      observer.disconnect();
      document.removeEventListener('mousemove', pointerMove);
      document.removeEventListener('mouseup', pointerEnd);
    });
  });
  createEffect(() => {
    const enabled = props.vim;
    if (editor) {
      editor.configure(enabled);
      props.onVimMode(enabled ? (editing() ? editor.mode() : 'outline') : null);
    }
  });
  createEffect(() => {
    const byId = definitionsById(),
      byName = definitionsByName();
    editor?.configureFields(
      id => byId.get(id)?.name,
      name => byName.get(name.toLowerCase())?.kind,
    );
  });
  createEffect(
    on(
      () => props.active,
      active => {
        if (active || !matchesCoarsePointer()) return;
        focusEpoch++;
        focusRequest = null;
        if (editor?.view.hasFocus) editor.view.contentDOM.blur();
        setEditorFocused(false);
        setEditing(null);
      },
      { defer: true },
    ),
  );
  createEffect(() => {
    if (doc.status() !== 'ready' || !pageReady() || !scroll || !editor) return;
    if (restoring) {
      restoring = false;
      if (initial.reveal && !reading()) revealRow(initial.reveal);
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
        setCaret(
          id
            ? { id, offset: id === saved?.id ? saved.offset : 0 }
            : reading() && saved && !doc.block(saved.id)
              ? saved
              : null,
        );
        if (props.active) scroll.focus({ preventScroll: true });
        scheduleReport();
        if (initial.scroll) restoreInitialAnchor();
        return;
      }
      if (journalPeriod) {
        setEditing(null);
        setSelected(null);
        setCaret(null);
        if (props.active)
          scroll
            .querySelector<HTMLButtonElement>('.journal-trail-segment[aria-expanded="true"]')
            ?.focus({ preventScroll: true });
        scheduleReport();
        return;
      }
      let first: Caret | null = saved && doc.block(saved.id) && indices().has(saved.id) ? saved : null;
      if (!saved) {
        const siblings = doc.outline.children(props.pageId);
        let empty: string | undefined;
        for (let index = siblings.length - 1; index >= 0; index--) {
          const id = siblings[index]!;
          if (doc.block(id)?.text === '' && !doc.block(id)?.archived) {
            empty = id;
            break;
          }
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
      // A touch visit selects its remembered or empty row without opening the keyboard.
      // Explicit creation/edit requests still begin editing; the shell strips them from touch history.
      if (first && !initial.edit && (saved || matchesCoarsePointer())) {
        setEditing(null);
        setSelected(first.id);
        setCaret(first);
        if (props.active) scroll.focus({ preventScroll: true });
        scheduleReport();
      } else if (first) {
        // A journal opens editing its last empty block. Focus that caret without scrolling it into view.
        const reveal = !!initial.edit && !initial.scroll;
        if (!reveal) suppressCaretScroll = true;
        if (!reveal && !initial.scroll) holdOpeningScroll = true;
        editAt(first.id, first.offset, !props.vim, reveal, false, reveal || !initial.scroll);
      }
      if (initial.scroll) restoreInitialAnchor();
    }
  });
  createEffect(() => {
    const anchor = pendingReadAnchor();
    if (
      !anchor ||
      !reading() ||
      doc.status() !== 'ready' ||
      !pageReady() ||
      fields.loading ||
      positionQuestions.loading ||
      relatedLoading()
    )
      return;
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
    const id = editing(),
      text = id ? doc.block(id)?.text : undefined;
    if (text !== undefined && editor?.id === id)
      queueMicrotask(() => {
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
    for (const token of textTokens(text))
      if (isStableReference(token) || (token.kind === 'tag' && token.id)) props.workshop.lookup(token.id!)();
    queueMicrotask(() => {
      if (!disposed && editor?.id === id) editor.refreshLabels();
    });
  });
  let previousVisible: string[] = [];
  createEffect(() => {
    if (!pageReady()) return;
    const visible = ids(),
      before = previousVisible;
    previousVisible = visible;
    const id = editing() ?? selected();
    if (!id || visible.includes(id) || composition()) return;
    queueMicrotask(() => {
      if (disposed || composition() || focusRestoresPending || (editing() ?? selected()) !== id || indices().has(id))
        return;
      selectSurvivor(id, before);
    });
  });
  createEffect(() => {
    storedFolds.set(`${props.pane}:${props.pageId}`, new Set(folds()));
  });
  onCleanup(() => {
    if (editing()) {
      doc.holdTag(editing()!, pendingType(editing()!));
      commitFieldEntry(editing()!, false);
    }
    disposed = true;
    setLinkedCitation(null);
    unregister();
    doc.release();
    editor?.destroy();
    cancelAnimationFrame(reportingFrame);
  });

  return (
    <>
      <div
        ref={scroll}
        class="outline-pane"
        classList={{
          'has-apparatus': apparatus(),
          'has-sigla': sigla().size > 0,
          'source-page': !!doc.root()?.source && !zoom(),
          'outline-dragging': drag.dragging(),
          'projection-compare': props.projection === 'compare',
        }}
        style={{ visibility: pageReady() ? undefined : 'hidden' }}
        aria-busy={!pageReady()}
        data-pane-pending={pageReady() ? undefined : ''}
        data-pane={props.pane}
        data-projection={reading() ? 'read' : 'outline'}
        data-multi-select={selectedIds().length > 1 ? '' : undefined}
        tabIndex={0}
        role="tree"
        aria-label={reading() ? 'Atom reading register' : 'Atom outline'}
        aria-owns={ids()
          .map(id => `outline-${props.pane}-${id}`)
          .join(' ')}
        onFocusIn={event => {
          props.onActivate();
          if ((event.target as Element).closest('.cm-editor')) setEditorFocused(true);
        }}
        onFocusOut={report}
        onKeyDown={event => {
          finishFoldMotion();
          structuralKey(event);
        }}
        onWheel={() => {
          finishFoldMotion();
          cancelScroll();
        }}
        onScroll={scrolled}
      >
        <OutlineHeader
          pageId={props.pageId}
          doc={doc}
          workshop={props.workshop}
          projection={props.projection}
          onProjection={props.onProjection}
          journalPeriod={journalPeriod}
          onActivate={props.onActivate}
          onOpen={props.onOpen}
          onDelete={props.onDelete}
          reading={reading()}
          zoom={zoom()}
          breadcrumbs={breadcrumbs()}
          zoomTo={zoomTo}
          rootTitle={rootTitle()}
          isNote={isNote()}
          noteKinds={noteKinds.error ? undefined : noteKinds.latest}
          positionZoom={positionZoom()}
          dossierFields={dossierFields()}
          definitions={definitions()}
          definitionsById={definitionsById()}
          fields={fields}
          type={type}
          titleGlyphs={titleGlyphs()}
          titlePills={titlePills()}
          titleTagKind={titleTagKind}
          renaming={renaming()}
          title={title()}
          setTitle={setTitle}
          titleCollision={titleCollision()}
          bindTitleInput={element => headerActions.bindTitleInput(element)}
          rename={rename}
          commitTitle={commitTitle}
          closeTitle={closeTitle}
          setMergeTarget={setMergeTarget}
          emptyRootBlock={emptyRootBlock()}
          isCollection={isCollection()}
          related={related()}
          openTable={openTable}
          restoreFocus={restoreFocus}
          setAliasesVisible={setAliasesVisible}
          depth={depth()}
          setStop={setStop}
          editAt={editAt}
          register={register()}
          localPositions={localPositions()}
          openRelation={openRelation}
          RowRelations={RowRelations}
          sourceDetailsOpen={sourceDetailsOpen()}
          setSourceDetailsOpen={setSourceDetailsOpen}
          sourceApparatusReady={sourceApparatusReady()}
          pageReady={pageReady()}
          setSourceHeaderReady={setSourceHeaderReady}
          sourceResets={sourceResets}
          sourceHighlights={zoom() || sourceHighlights.error ? undefined : sourceHighlights()}
          sourceColors={sourceColors()}
          setSourceColors={setSourceColors}
          sourceGrouped={sourceGrouped()}
          setSourceGrouped={setSourceGrouped}
          sourceFieldsVisible={sourceFieldsVisible()}
          setSourceFieldsVisible={setSourceFieldsVisible}
          projectSummary={projectSummary}
          capabilities={capabilities}
          TaskSummary={TaskSummary}
          QuestionSummary={QuestionSummary}
          showArchived={showArchived()}
          setShowArchived={setShowArchived}
          message={message()}
          setMessage={setMessage}
          glossId={glossId()}
          FieldSlots={fieldSheet.FieldSlots}
          idsCount={ids().length}
          branches={branches}
          apply={apply}
          apparatus={apparatus()}
          holders={holders()}
          linkedPages={linkedPages()}
          holderRelations={holderRelations()}
          siglumSources={siglumSources()}
          sigla={sigla()}
          longPage={longPage()}
          scrolledAway={scrolledAway()}
          sectionName={sectionName()}
          bindNavigator={element => viewportController.bindNavigator(element)}
          bindHeading={element => {
            heading = element;
          }}
          setMenu={setMenu}
          cancelScroll={cancelScroll}
          scrollToTop={() => {
            scroll.scrollTop = 0;
          }}
          scrolled={scrolled}
          onJumpSection={id => {
            revealRow(id);
            if (!reading() && indices().has(id)) virtualizer.scrollToIndex(indices().get(id)!, { align: 'start' });
            requestAnimationFrame(() => {
              let row = rowAnchor(id);
              if (!row && reading()) {
                const start = doc.outline.indexOf(id),
                  end = doc.outline.subtreeEnd(start);
                const child = ids().find(candidate => {
                  const at = doc.outline.indexOf(candidate);
                  return at > start && at < end;
                });
                if (child) row = rowAnchor(child);
              }
              if (row)
                scroll.scrollTop +=
                  row.getBoundingClientRect().top -
                  scroll.getBoundingClientRect().top -
                  viewportController.navigatorHeight;
              scrolled();
            });
          }}
          scheduleReport={scheduleReport}
        />
        <div ref={list} class="outline-list" style={{ height: reading() ? undefined : `${listHeight()}px` }}>
          <Show
            when={reading()}
            fallback={
              <>
                <Show when={drag.indicator() ?? images.indicator()}>
                  {drop => (
                    <div
                      class="outline-drop-indicator"
                      aria-hidden="true"
                      data-drop-depth={drop().depth - baseDepth()}
                      data-drop-edge={drop().edge}
                      style={{ top: `${drop().top}px`, left: `${drop().left}px` }}
                    />
                  )}
                </Show>
                <For each={foldGroups().before}>
                  {id => (
                    <Row
                      id={id}
                      item={() => virtualItems().get(id)!}
                      placeholder={emptyRootBlock() === id ? 'Start writing…' : undefined}
                    />
                  )}
                </For>
                <div
                  ref={element => viewportController.bindFoldChildren(element)}
                  class="outline-motion-group"
                  style={{ opacity: foldMotion()?.opening ? 0 : undefined }}
                >
                  <For each={foldGroups().children}>
                    {id => (
                      <Row
                        id={id}
                        item={() => virtualItems().get(id)!}
                        placeholder={emptyRootBlock() === id ? 'Start writing…' : undefined}
                      />
                    )}
                  </For>
                </div>
                <div
                  ref={element => viewportController.bindFoldFollowing(element)}
                  class="outline-motion-group"
                  style={{
                    transform: foldMotion()?.opening
                      ? `translateY(${foldMotion()!.beforeSize - virtualizer.getTotalSize()}px)`
                      : undefined,
                  }}
                >
                  <For each={foldGroups().after}>
                    {id => (
                      <Row
                        id={id}
                        item={() => virtualItems().get(id)!}
                        placeholder={emptyRootBlock() === id ? 'Start writing…' : undefined}
                      />
                    )}
                  </For>
                </div>
                <div
                  ref={element => viewportController.bindFoldEditor(element)}
                  class="outline-motion-group"
                  style={{
                    transform:
                      foldMotion()?.opening && foldMotion()!.afterIds.includes(editing()!)
                        ? `translateY(${foldMotion()!.beforeSize - virtualizer.getTotalSize()}px)`
                        : undefined,
                  }}
                >
                  <Show keyed when={editing() && virtualItems().has(editing()!) ? editing() : null}>
                    {id => (
                      <Row
                        id={id}
                        item={() => virtualItems().get(id)!}
                        placeholder={emptyRootBlock() === id ? 'Start writing…' : undefined}
                      />
                    )}
                  </Show>
                </div>
              </>
            }
          >
            <ReadRegister
              register={readView()}
              doc={doc}
              workshop={props.workshop}
              disclosures={readDisclosures()}
              onDisclosure={key => {
                setReadDisclosures(previous => {
                  const next = new Set(previous);
                  next.has(key) ? next.delete(key) : next.add(key);
                  return next;
                });
                scheduleReport();
                requestAnimationFrame(scrolled);
              }}
              row={id => <Row id={id} natural placeholder={emptyRootBlock() === id ? 'Start writing…' : undefined} />}
              onCompare={() => props.onProjection?.('compare')}
              onAddReading={anchor => openRelation(props.pageId, 'reading', anchor)}
              onWriteAssessment={id =>
                apply({ kind: 'writeAssessment', parentId: id, assessedOn: props.workshop.todayDate() }, true)
              }
              onOpenReading={(id, beside) =>
                beside ? props.onOpen({ kind: 'page', pageId: props.pageId, blockId: id }, true) : zoomTo(id)
              }
              siglum={id => {
                const source = positionSource(id);
                return source ? sigla().get(source) : undefined;
              }}
            />
          </Show>
        </div>
        <Show when={!zoom() && ids().length && !holderBoundary() && related()?.heldReadings.length}>
          <HeldReadings rows={related()?.heldReadings ?? []} workshop={props.workshop} onOpen={props.onOpen} />
        </Show>
        <Show when={doc.root()?.source && !zoom() && filedElsewhere().length}>
          <section class="related-sections source-elsewhere" aria-label="Filed elsewhere">
            <h3 class="outline-highlights-label">
              Filed elsewhere <span>{filedElsewhere().length}</span>
            </h3>
            <For each={filedElsewhere()}>
              {row => (
                <Button
                  class="library-highlight"
                  onClick={event =>
                    props.onOpen(
                      { kind: 'page', pageId: row.block.page.id, blockId: row.block.block.id },
                      opensBeside(event),
                    )
                  }
                >
                  <BlockText text={row.block.block.text} workshop={props.workshop} interactive={false} />
                  <span class="library-highlight-meta">
                    ¶{row.citation.ordinal + 1} · {row.block.page.text}
                  </span>
                </Button>
              )}
            </For>
          </section>
        </Show>
        <Show when={!zoom() && sourceHighlights.error}>
          <p class="library-error" role="alert">
            {String(sourceHighlights.error)}
          </p>
        </Show>
        <Show when={doc.root()?.source && fields.error}>
          <p class="library-error" role="alert">
            {String(fields.error)}
          </p>
        </Show>
        <Show when={doc.status() === 'ready' && !zoom() && isCollection()}>
          <CollectionSources />
        </Show>
        <Show when={doc.status() === 'ready' && ids().length === 0 && depthFilter() === undefined}>
          <button
            type="button"
            class="add-first-block"
            onClick={() => apply({ kind: 'insert', parentId: zoom() ?? props.pageId, after: null }, true)}
          >
            <Icon name="plus" />
            Add an atom
          </button>
        </Show>
        {/* Generated sections follow the outline on Today alone, as the workshop's template switches them. */}
        <Show when={journalLayout()?.missing.end.length}>
          <div class="journal-missing-end">
            <MissingSections workshop={props.workshop} sections={journalLayout()!.missing.end} />
          </div>
        </Show>
        <Show when={!zoom() && doc.root()?.kind === 'journal' && doc.root()!.text === props.workshop.todayDate()}>
          <div class="related-sections journal-highlights">
            <Show when={section(props.workshop.todayTemplate(), 'research')?.on}>
              <ResearchToRevisit
                name={section(props.workshop.todayTemplate(), 'research')!.name}
                workshop={props.workshop}
                onOpen={props.onOpen}
              />
            </Show>
            <Show when={section(props.workshop.todayTemplate(), 'highlights')?.on}>
              <JournalResurface
                name={section(props.workshop.todayTemplate(), 'highlights')!.name}
                date={doc.root()!.text}
                workshop={props.workshop}
                onOpen={props.onOpen}
              />
            </Show>
          </div>
        </Show>
        <Show when={doc.status() === 'ready' && !zoom() && related()?.works.length}>
          <PersonWorks api={props.workshop.api} pageId={props.pageId} rows={related()!.works} onOpen={props.onOpen} />
        </Show>
        <Show when={!zoom()}>
          <projectSummary.LinkedTasks />
        </Show>
        <Show
          when={
            doc.status() === 'ready' &&
            !zoom() &&
            (doc.root()?.project || doc.root()?.manual_types.some(title => title.toLocaleLowerCase() === 'stream'))
          }
        >
          <Arrivals doc={doc} workshop={props.workshop} onOpen={props.onOpen} onAdded={restoreFocus} />
        </Show>
        <Show
          when={
            doc.status() === 'ready' &&
            !zoom() &&
            (mentionsAvailable() ||
              relatedError() ||
              (related()?.total ?? 0) + (related()?.tagged.length ?? 0) + (related()?.about.length ?? 0) > 0)
          }
        >
          <div class="related-sections">
            <Show when={related()?.about.length}>
              <Related
                title="Perspectives filed elsewhere"
                rows={related()?.about ?? []}
                revealId={reading() ? (pendingReadAnchor()?.id ?? props.view.scroll?.id) : undefined}
                expanded={readDisclosures().has('related:positions')}
                onExpanded={expanded => {
                  setReadDisclosures(previous => {
                    const next = new Set(previous);
                    expanded ? next.add('related:positions') : next.delete('related:positions');
                    return next;
                  });
                  scheduleReport();
                }}
                relations
              />
            </Show>
            <Show when={doc.root()?.source}>
              <Backlinks cited />
            </Show>
            <Show when={doc.root()?.source || relatedError() || related()?.total}>
              <Backlinks />
            </Show>
            <Show when={mentionsAvailable()}>
              <UnlinkedMentions />
            </Show>
            <Show when={relatedError() || related()?.tagged.length}>
              <Related title="Tagged atoms" rows={relatedError() ? [] : (related()?.tagged ?? [])} />
            </Show>
          </div>
        </Show>
        <Show when={doc.status() === 'ready' && zoom()}>
          <div class="related-sections">
            <Backlinks />
          </div>
        </Show>
        <Show keyed when={menu()}>
          {state => (
            <Menu
              class="outline-menu"
              anchor={state.anchor}
              label={state.label}
              title={state.title}
              context={state.context}
              caption={state.caption}
              header={state.header}
              items={state.items}
              onDismiss={() => {
                setMenu(null);
                restoreFocus();
              }}
            />
          )}
        </Show>
        <Show keyed when={mergeTarget()}>
          {target => (
            <PageMergeConfirmation
              anchor={target.anchor}
              workshop={props.workshop}
              from={target.from}
              into={target.page}
              onDismiss={() => setMergeTarget(undefined)}
              onMerged={id => {
                setMergeTarget(undefined);
                props.onOpen({ kind: 'page', pageId: id }, false);
              }}
            />
          )}
        </Show>
        <Show when={tagTemplate()}>
          {target => (
            <Popup
              anchor={target().anchor}
              label={receiptType.error ? 'Tag fields' : `Fields for #${receiptType()?.page.text ?? ''}`}
              class="tag-template-popup"
              width={560}
              fitContent
              ready={!receiptType.loading || !!receiptType.error}
              onDismiss={() => setTagTemplate(undefined)}
            >
              <Show when={receiptType.error}>
                <p class="error" role="alert">
                  Couldn't load template · {String(receiptType.error)}
                </p>
              </Show>
              <Show when={!receiptType.error && receiptType()}>
                {value => (
                  <TemplateEditor
                    type={value()}
                    fields={definitions()}
                    workshop={props.workshop}
                    onError={setMessage}
                    onOpen={props.onOpen}
                    register={{ fields: fields()?.fields ?? [], pageId: value().page.id }}
                  />
                )}
              </Show>
            </Popup>
          )}
        </Show>
        <CapabilityPopups />
        <CompletionPopups />
        <fieldSheet.Popups />
        <RelationPopups />
        <ViewEmbedPopups />
        <MoveToPagePopup />
        <Show keyed when={bulkDate()}>
          {state => (
            <DatePicker
              workshop={props.workshop}
              anchor={state.anchor}
              label={
                state.field === 'deadline' ? `Set deadline (${state.ids.length})` : `Schedule (${state.ids.length})`
              }
              value={doc.block(state.ids[0] ?? '')?.task?.[state.field] ?? null}
              time={state.field === 'scheduled' ? null : undefined}
              contextDate={contextDate()}
              onDismiss={() => {
                setBulkDate(null);
                restoreFocus();
              }}
              onSelect={value => {
                const patch =
                  state.field === 'scheduled'
                    ? { scheduled: value.date ? (value.time ? `${value.date} ${value.time}` : value.date) : null }
                    : { deadline: value.date };
                capabilities.invoke(capabilities.bulkPatch(state.ids, patch));
                setBulkDate(null);
                restoreFocus();
              }}
            />
          )}
        </Show>
        <images.ImagePopups />
      </div>
      <Show when={selectedIds().length > 1 && !editing() && !editingBarVisible()}>
        {(() => {
          const targets = () => roots();
          const allTasks = () => targets().length > 0 && targets().every(id => !!doc.block(id)?.task?.status);
          const anyUnfinished = () =>
            targets().some(id => {
              const task = doc.block(id)?.task;
              return task?.status && !isFinished(task);
            });
          const allArchived = () => targets().length > 0 && targets().every(id => doc.block(id)?.archived);
          return (
            <div
              class="outline-bulk-bar"
              role="toolbar"
              aria-label="Selected atoms actions"
              onMouseDown={event => event.preventDefault()}
            >
              <span class="outline-bulk-count">{targets().length} selected</span>
              <Button
                icon={allTasks() && anyUnfinished() ? 'check' : 'select'}
                shortcut="⌘Enter"
                onClick={() => capabilities.invoke(capabilities.bulkToggle(targets()))}
              >
                {!allTasks() ? 'Make tasks' : anyUnfinished() ? 'Done' : 'Reopen'}
              </Button>
              <Button
                icon="calendar"
                onClick={event => setBulkDate({ ids: [...targets()], field: 'scheduled', anchor: event.currentTarget })}
              >
                Schedule
              </Button>
              <Button icon="moveto" onClick={() => context.openMoveToPage()}>
                Move…
              </Button>
              <Button
                icon="archive"
                onClick={() => apply({ kind: 'archive', ids: [...targets()], archived: !allArchived() }, false)}
              >
                {allArchived() ? 'Unarchive' : 'Archive'}
              </Button>
              <Button
                class="outline-bulk-danger"
                icon="trash"
                shortcut="Backspace"
                onClick={() => apply({ kind: 'delete', ids: [...targets()] }, false)}
              >
                Delete
              </Button>
              <Button
                icon="more"
                label="More actions"
                aria-haspopup="menu"
                onClick={event => bulkMenu(event.currentTarget, targets())}
              />
              <Button
                class="outline-bulk-clear"
                icon="close"
                label="Clear selection"
                shortcut="Esc"
                onClick={clearSelection}
              />
            </div>
          );
        })()}
      </Show>
      <Show when={props.projection === 'compare'}>
        <div class="embedded-comparison">
          <ComparePane
            subjectId={props.pageId}
            view={props.view.compare ?? { scroll: 0 }}
            workshop={props.workshop}
            onActivate={props.onActivate}
            onOpen={props.onOpen}
            onViewChange={compare => props.onViewChange({ ...props.view, compare })}
          />
        </div>
      </Show>
      <Show when={editingBarVisible()}>
        <OutlineEditingBar
          bindRef={element => {
            editingBar = element;
          }}
          viewport={viewport()}
          composition={composition()}
          editing={editing()}
          doc={doc}
          editor={() => editor}
          capabilities={capabilities}
          roots={roots}
          apply={apply}
          undo={undo}
          rowFocus={rowFocus}
        />
      </Show>
    </>
  );
}
