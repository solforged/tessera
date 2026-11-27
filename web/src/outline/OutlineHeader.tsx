import { For, Show, batch, createMemo, createSignal, lazy } from 'solid-js';
import type { Accessor, JSX, Resource, Setter } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Block, FieldDefinition, Fields, HighlightResult, NoteKind, QuestionRow, Type } from '../api/types';
import { opensBeside } from '../core/beside';
import type { Caret, Depth, OpenTarget } from '../core/contract';
import { fieldEntryId } from '../core/field-entry';
import type { Edit, EditResult, PageDocument, TextRange, WorkshopClient } from '../document/contract';
import type { Token } from '../document/text-tokens';
import { titleKey } from '../document/title-key';
import { fieldRole } from '../fields/roles';
import { TemplateEditor } from '../fields/TemplateEditor';
import { NoteAliases, NoteEyebrow, NoteLine } from '../notes/NoteHeader';
import { noteKindIcon } from '../notes/kinds';
import type { createProjectSummary } from '../projects/ProjectSummary';
import { NoteRevisit } from '../review/NoteRevisit';
import { JournalHeader } from '../tasks/JournalHeader';
import { TaskStatusButton } from '../tasks/TaskControls';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { MenuItem } from '../ui/Menu';
import { isPhone } from '../ui/viewport';
import { Apparatus } from './Apparatus';
import type { HolderRelation } from './Apparatus';
import { BlockText } from './BlockText';
import { CardSummary } from './CardSummary';
import type { OutlinePaneProps } from './contract';
import type { MenuState, OutlineCapabilityActions } from './context';
import type { PaneEditor } from './editor';
import { GLOSS_FIELD } from './gloss';
import { HeldReadings } from './HeldReadings';
import { displayTitle, plainText, readableText } from './names';
import { pageMergeDisabledReason } from './PageMerge';
import { AssessmentJournal, QuestionBranches, QuestionParent } from './Questions';
import { isReadingSubject, readingCounts } from './read-register';
import type { ReadingRegister } from './read-register';
import { TypePill } from './references';
import type { createOutlineRelated } from './Related';
import { ensureField } from './source-fields';
import { SourceDetails } from './SourceDetails';
import { CitationChip, SourceHeader } from './SourceHeader';

const RecipeSection = lazy(() =>
  import('../fields/CardTemplatesPane').then(module => ({ default: module.RecipeSection })),
);
const SpreadPane = lazy(() => import('../notes/SpreadPane').then(module => ({ default: module.SpreadPane })));

export interface MergeTargetState {
  page: Block;
  from: { id: string; text: string };
  anchor: HTMLElement;
}

export function createOutlineHeaderActions(options: {
  pageId: string;
  doc: PageDocument;
  workshop: WorkshopClient;
  active: () => boolean;
  vim: () => boolean;
  onVimMode: (mode: 'normal' | 'insert' | 'visual' | 'outline' | null) => void;
  disposed: () => boolean;
  focusEpoch: () => number;
  bumpFocusEpoch: () => number;
  clearFocusRequest: () => void;
  clearCompletion: () => void;
  setEditing: Setter<string | null>;
  setTextRange: Setter<TextRange | null>;
  setMessage: Setter<string>;
  caret: Accessor<Caret | null>;
  glossId: Accessor<string | null>;
  zoom: Accessor<string | null>;
  zoomTo: (id: string | null) => void;
  depth: Accessor<Depth>;
  setStop: (stop: Depth) => void;
  setAliasesVisible: Setter<boolean>;
  setFolds: Setter<Set<string>>;
  definitionsByName: Accessor<Map<string, FieldDefinition>>;
  onCreatedField: (field: FieldDefinition) => void;
  editAt: (id: string, offset?: number, insert?: boolean, reveal?: boolean, activate?: boolean) => void;
  scroll: () => HTMLDivElement | undefined;
  scheduleReport: () => void;
}) {
  const [renaming, setRenaming] = createSignal(false);
  const [title, setTitle] = createSignal('');
  const [mergeTarget, setMergeTarget] = createSignal<MergeTargetState>();
  let titleInput: HTMLInputElement | undefined;

  const titleCollision = createMemo(() => {
    const value = titleKey(title().trim());
    return renaming() && value
      ? options.workshop
          .roots()
          .find(page => page.id !== options.pageId && page.kind === 'page' && titleKey(page.text) === value)
      : undefined;
  });

  function rename() {
    if (options.doc.root()?.kind !== 'page') return;
    setTitle(options.doc.root()!.text);
    setRenaming(true);
    queueMicrotask(() => {
      titleInput?.focus();
      titleInput?.select();
    });
  }

  function closeTitle() {
    options.bumpFocusEpoch();
    options.clearFocusRequest();
    batch(() => {
      setRenaming(false);
      options.setEditing(null);
      options.clearCompletion();
      options.setTextRange(null);
      options.setMessage('');
    });
    options.onVimMode(options.vim() ? 'outline' : null);
    if (options.active()) options.scroll()?.focus({ preventScroll: true });
    options.scheduleReport();
  }

  function commitTitle() {
    const collision = titleCollision();
    if (collision && titleInput) {
      const reason = pageMergeDisabledReason(options.doc.root(), options.doc.capabilities(options.pageId));
      if (reason) {
        options.setMessage(reason);
        return;
      }
      options.setMessage('');
      setMergeTarget({
        page: collision,
        from: { id: options.pageId, text: options.doc.root()!.text },
        anchor: titleInput,
      });
      return;
    }
    const result = options.doc.rename(title());
    if (result.ok) closeTitle();
    else {
      options.setMessage(result.reason);
      titleInput?.focus();
    }
  }

  function abandonTitle(event: PointerEvent) {
    if (!renaming() || mergeTarget()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.outline-title-row, [role="dialog"], [role="menu"]')) return;
    closeTitle();
  }

  /** Edits the gloss, adding the entry as the page's first block when there is none. */
  function addGloss() {
    const existing = options.glossId();
    if (existing) {
      if (options.zoom()) options.zoomTo(null);
      const value = options.doc.outline.children(existing)[0];
      if (value) options.editAt(value, options.doc.block(value)?.text.length ?? 0, true);
      return;
    }
    const before = options.caret();
    const epoch = options.focusEpoch();
    void (async () => {
      try {
        const field =
          options.definitionsByName().get(GLOSS_FIELD.toLowerCase()) ??
          (await ensureField(options.workshop, GLOSS_FIELD, 'text', 'standfirst'));
        if (options.disposed()) return;
        options.onCreatedField(field);
        const result = options.doc.edit(
          {
            kind: 'addFieldEntries',
            parentId: options.pageId,
            after: null,
            entries: [{ fieldId: field.id, value: '' }],
          },
          before,
        );
        if (!result.ok) {
          options.setMessage(result.reason);
          return;
        }
        if (result.caret && options.active() && options.focusEpoch() === epoch)
          options.editAt(result.caret.id, result.caret.offset, true, true, false);
      } catch (error) {
        if (!options.disposed()) options.setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }

  /** Aliases are ordinary field values; a new one always opens for editing. */
  function addAlias() {
    void (async () => {
      try {
        const field = options.definitionsByName().get('aliases') ?? (await ensureField(options.workshop, 'aliases'));
        options.onCreatedField(field);
        if (options.disposed()) return;
        if (options.zoom()) options.zoomTo(null);
        if (options.depth() !== 'full') options.setStop('full');
        options.setAliasesVisible(true);
        const entry = options.doc.outline
          .children(options.pageId)
          .find(id => !options.doc.isArchived(id) && fieldEntryId(options.doc.block(id)?.text ?? '') === field.id);
        if (entry)
          options.setFolds(previous => {
            const next = new Set(previous);
            next.delete(entry);
            return next;
          });
        const result = entry
          ? options.doc.edit(
              { kind: 'insert', parentId: entry, after: options.doc.outline.children(entry).at(-1) ?? null, text: '' },
              options.caret(),
            )
          : options.doc.edit(
              {
                kind: 'addFieldEntries',
                parentId: options.pageId,
                after: options.glossId(),
                entries: [{ fieldId: field.id, value: '' }],
              },
              options.caret(),
            );
        if (!result.ok) {
          options.setMessage(result.reason);
          return;
        }
        if (result.caret) options.editAt(result.caret.id, result.caret.offset, true);
      } catch (error) {
        if (!options.disposed()) options.setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }

  return {
    renaming,
    title,
    setTitle,
    mergeTarget,
    setMergeTarget,
    titleCollision,
    bindTitleInput(element: HTMLInputElement) {
      titleInput = element;
    },
    rename,
    closeTitle,
    commitTitle,
    abandonTitle,
    addGloss,
    addAlias,
  };
}

export function OutlineHeader(props: {
  pageId: string;
  doc: PageDocument;
  workshop: WorkshopClient;
  projection: 'outline' | 'read' | 'compare' | undefined;
  onProjection: ((projection: 'outline' | 'read' | 'compare') => void) | undefined;
  journalPeriod: OutlinePaneProps['journalPeriod'];
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onDelete: OutlinePaneProps['onDelete'];
  reading: boolean;
  zoom: string | null;
  breadcrumbs: string[];
  zoomTo(id: string | null): void;
  rootTitle: string | undefined;
  isNote: boolean;
  noteKinds: NoteKind[] | undefined;
  positionZoom: string | null;
  dossierFields: { fieldId: string; name: string; value: string }[];
  definitions: FieldDefinition[];
  definitionsById: Map<string, FieldDefinition>;
  fields: Resource<Fields>;
  type: Resource<Type>;
  titleGlyphs: Token[];
  titlePills: Token[];
  titleTagKind: (token: Token) => NoteKind | undefined;
  renaming: boolean;
  title: string;
  setTitle: Setter<string>;
  titleCollision: Block | undefined;
  bindTitleInput(element: HTMLInputElement): void;
  rename(): void;
  commitTitle(): void;
  closeTitle(): void;
  setMergeTarget: Setter<MergeTargetState | undefined>;
  emptyRootBlock: string | undefined;
  isCollection: boolean;
  related: ReturnType<ReturnType<typeof createOutlineRelated>['related']>;
  openTable(beside: boolean): void;
  restoreFocus(): void;
  setAliasesVisible: Setter<boolean>;
  depth: Depth;
  setStop(stop: Depth): void;
  editAt(id: string, offset?: number, insert?: boolean): void;
  register: ReadingRegister;
  localPositions: number;
  openRelation(id: string, kind: 'holder' | 'subject' | 'integrate' | 'reading', anchor?: HTMLElement | null): void;
  RowRelations: (props: { id: string; heading?: boolean }) => JSX.Element;
  sourceDetailsOpen: boolean;
  setSourceDetailsOpen: Setter<boolean>;
  sourceApparatusReady: boolean;
  pageReady: boolean;
  setSourceHeaderReady: Setter<boolean>;
  sourceResets: (entryId?: string) => MenuItem[];
  sourceHighlights: HighlightResult | undefined;
  sourceColors: string[];
  setSourceColors: Setter<string[]>;
  sourceGrouped: boolean;
  setSourceGrouped: Setter<boolean>;
  sourceFieldsVisible: boolean;
  setSourceFieldsVisible: Setter<boolean>;
  projectSummary: ReturnType<typeof createProjectSummary>;
  capabilities: OutlineCapabilityActions;
  TaskSummary: (props: { id: string }) => JSX.Element;
  QuestionSummary: (props: { id: string }) => JSX.Element;
  showArchived: boolean;
  setShowArchived: Setter<boolean>;
  message: string;
  setMessage: Setter<string>;
  glossId: string | null;
  FieldSlots: (props: { id: string }) => JSX.Element;
  idsCount: number;
  branches: Resource<QuestionRow[]>;
  apply(intent: Edit, keepEditing?: boolean): EditResult | undefined;
  apparatus: boolean;
  holders: readonly string[];
  linkedPages: readonly string[];
  holderRelations: readonly HolderRelation[];
  siglumSources: string[];
  sigla: Map<string, string>;
  longPage: boolean;
  scrolledAway: boolean;
  sectionName: string;
  bindNavigator(element: HTMLDivElement): void;
  bindHeading(element: HTMLDivElement): void;
  setMenu: Setter<MenuState | null>;
  cancelScroll(): void;
  scrollToTop(): void;
  scrolled(): void;
  onJumpSection(id: string): void;
  scheduleReport(): void;
}) {
  let sourceDetailsOpener: HTMLElement | undefined;

  return (
    <>
      <Show when={props.doc.root()?.kind === 'page' && !props.zoom && props.projection !== 'compare'}>
        <div
          ref={props.bindNavigator}
          class="section-navigator"
          classList={{ 'section-navigator-shown': props.longPage && props.scrolledAway }}
          onKeyDown={event => event.stopPropagation()}
        >
          <Button
            aria-haspopup="menu"
            onClick={event => {
              const sections = Array.from({ length: props.doc.outline.size() }, (_, at) =>
                props.doc.outline.idAt(at),
              ).filter(
                id =>
                  !props.doc.isArchived(id) &&
                  (props.doc.block(id)?.position ||
                    (props.doc.block(id)?.heading && props.doc.outline.parentOf(id) === props.pageId)),
              );
              props.setMenu({
                anchor: event.currentTarget,
                label: 'Sections and perspectives',
                items: [
                  {
                    label: 'Opening',
                    action: () => {
                      props.cancelScroll();
                      props.scrollToTop();
                      props.scrolled();
                    },
                  },
                  ...sections.map(id => ({
                    label: props.doc.block(id)?.position
                      ? `Perspectives · ${props.doc.block(id)?.position?.holder_id ? (props.workshop.lookup(props.doc.block(id)!.position!.holder_id!)()?.text ?? 'Loading holder…') : 'Unattributed'}`
                      : plainText(props.doc.block(id)?.text ?? '', target => props.workshop.lookup(target)),
                    action: () => props.onJumpSection(id),
                  })),
                ],
              });
            }}
          >
            {props.sectionName || 'Opening'}
          </Button>
        </div>
      </Show>
      <Show when={props.apparatus}>
        <Apparatus
          workshop={props.workshop}
          holders={props.holders}
          linked={props.linkedPages}
          relations={props.holderRelations}
          sources={props.siglumSources.map(id => ({ id, siglum: props.sigla.get(id)! }))}
          onOpen={props.onOpen}
        />
      </Show>
      <Show when={props.sourceDetailsOpen && props.doc.root()?.source}>
        <SourceDetails
          workshop={props.workshop}
          pageId={props.pageId}
          onOpen={props.onOpen}
          opener={sourceDetailsOpener}
          onClose={() => props.setSourceDetailsOpen(false)}
        />
      </Show>
      <div
        ref={props.bindHeading}
        class="outline-heading"
        style={{ visibility: props.doc.root()?.source && !props.sourceApparatusReady ? 'hidden' : undefined }}
      >
        <Show when={props.zoom}>
          <nav class="outline-breadcrumbs" aria-label="Zoom breadcrumbs">
            <button type="button" onClick={() => props.zoomTo(null)}>
              {props.rootTitle}
            </button>
            <For each={props.breadcrumbs}>
              {id => (
                <>
                  <Icon name="right" />
                  <button type="button" onClick={() => props.zoomTo(id)}>
                    {readableText(
                      props.doc.block(id)?.text ?? '',
                      reference => props.workshop.lookup(reference),
                      props.doc.block(id)?.position?.deleted_holder,
                    ) || 'Empty atom'}
                  </button>
                </>
              )}
            </For>
          </nav>
        </Show>
        <Show when={props.isNote}>
          <NoteEyebrow kinds={props.noteKinds} onOpen={props.onOpen} />
        </Show>
        <Show when={props.positionZoom}>
          {id => (
            <div class="position-dossier">
              <h1>
                <Show
                  when={
                    props.doc.block(id())?.position?.holder_id ?? props.doc.block(id())?.position?.deleted_holder?.id
                  }
                  fallback="Unattributed"
                >
                  {holder => (
                    <BlockText
                      text={`[[${holder()}]]`}
                      deletedHolder={props.doc.block(id())?.position?.deleted_holder}
                      workshop={props.workshop}
                      onOpen={props.onOpen}
                    />
                  )}
                </Show>
                <Show
                  when={
                    props.dossierFields.find(
                      field => fieldRole(props.definitionsById.get(field.fieldId)) === 'standfirst',
                    )?.value
                  }
                >
                  {gist => (
                    <>
                      {' '}
                      · <BlockText text={gist()} workshop={props.workshop} onOpen={props.onOpen} />
                    </>
                  )}
                </Show>
              </h1>
              <Show when={props.dossierFields.find(field => field.name.trim().toLowerCase() === 'work')?.value}>
                {work => (
                  <div class="dossier-work">
                    <BlockText text={work()} workshop={props.workshop} onOpen={props.onOpen} />
                  </div>
                )}
              </Show>
              <Show when={props.doc.block(id())?.position?.subject_id}>
                {subject => (
                  <div class="dossier-subject">
                    on{' '}
                    <Button
                      onClick={event => {
                        const block = props.workshop.lookup(subject())();
                        if (block)
                          props.onOpen(
                            {
                              kind: 'page',
                              pageId: block.page_id,
                              ...(block.kind === 'block' ? { blockId: block.id } : {}),
                            },
                            opensBeside(event),
                          );
                      }}
                    >
                      <span>
                        <BlockText
                          text={props.workshop.lookup(subject())()?.text ?? 'Loading subject…'}
                          workshop={props.workshop}
                          interactive={false}
                        />
                      </span>
                    </Button>
                  </div>
                )}
              </Show>
            </div>
          )}
        </Show>
        <Show when={!props.positionZoom && (!props.zoom || !props.doc.root()?.source || props.renaming)}>
          <div class="outline-title-row">
            <Show
              when={props.renaming}
              fallback={
                <h1 classList={{ 'outline-title-tagged': props.titleGlyphs.length + props.titlePills.length > 0 }}>
                  <For each={props.titleGlyphs}>
                    {token => (
                      <Show when={props.titleTagKind(token)}>{kind => <Icon name={noteKindIcon(kind())} />}</Show>
                    )}
                  </For>
                  <button
                    class="outline-title"
                    type="button"
                    disabled={props.doc.root()?.kind !== 'page'}
                    onClick={props.rename}
                  >
                    {props.rootTitle || 'Loading…'}
                  </button>
                  <For each={props.titlePills}>
                    {token => (
                      <TypePill
                        id={token.id}
                        title={token.alias || token.value}
                        workshop={props.workshop}
                        onOpen={props.onOpen}
                        onRestoreFocus={props.restoreFocus}
                      />
                    )}
                  </For>
                </h1>
              }
            >
              <input
                ref={props.bindTitleInput}
                class="title-input"
                aria-label="Atom title"
                value={props.title}
                onInput={event => props.setTitle(event.currentTarget.value)}
                onKeyDown={event => {
                  if (event.isComposing) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    props.commitTitle();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    props.closeTitle();
                  }
                }}
              />
              <Show
                when={props.titleCollision}
                fallback={
                  <Button class="bordered" onClick={props.commitTitle}>
                    Save title
                  </Button>
                }
              >
                {page => (
                  <Button
                    class="bordered"
                    disabled={!!pageMergeDisabledReason(props.doc.root(), props.doc.capabilities(props.pageId))}
                    title={pageMergeDisabledReason(props.doc.root(), props.doc.capabilities(props.pageId))}
                    onClick={event => {
                      props.setMessage('');
                      props.setMergeTarget({
                        page: page(),
                        from: { id: props.pageId, text: props.doc.root()!.text },
                        anchor: event.currentTarget,
                      });
                    }}
                  >
                    Merge into “{displayTitle(page().text, id => props.workshop.lookup(id))}”
                  </Button>
                )}
              </Show>
              <Button onClick={props.closeTitle}>Cancel</Button>
            </Show>
            <Show
              when={
                !isPhone() &&
                props.doc.root()?.kind === 'page' &&
                !props.doc.root()?.source &&
                !props.fields.error &&
                props.fields() &&
                props.fields()?.page_id !== props.pageId &&
                (props.isCollection || (!props.doc.root()?.project && !props.type.error && !!props.type()?.members))
              }
            >
              <div class="outline-header-actions">
                <Button
                  class={props.emptyRootBlock ? 'outline-table-quiet' : undefined}
                  icon="table"
                  label="Table"
                  shortcut="⌘⇧T"
                  onClick={event => props.openTable(opensBeside(event))}
                >
                  Table
                  <Show
                    when={
                      props.isCollection
                        ? props.related?.collection?.total
                        : !props.doc.root()?.project && !props.type.error && props.type()?.members
                    }
                  >
                    {count => <span class="table-member-count">{count()}</span>}
                  </Show>
                </Button>
              </div>
            </Show>
          </div>
        </Show>
        <Show when={props.isNote}>
          <NoteAliases
            doc={props.doc}
            fields={props.definitions}
            onEdit={entry => {
              props.setAliasesVisible(true);
              if (props.depth !== 'full') props.setStop('full');
              const value = props.doc.outline.children(entry).find(id => !props.doc.isArchived(id));
              if (value) props.editAt(value, props.doc.block(value)?.text.length ?? 0, true);
            }}
          />
          <NoteLine pageId={props.pageId} workshop={props.workshop}>
            <Show when={props.doc.status() === 'ready' && !props.doc.root()?.question}>
              <NoteRevisit id={props.pageId} workshop={props.workshop} />
            </Show>
          </NoteLine>
        </Show>
        <Show when={isReadingSubject(props.doc) && !props.reading && !props.zoom}>
          <div class="reading-register-actions">
            <span class="reading-counts">{readingCounts(props.register.slips)}</span>
            <Show when={props.localPositions > 1}>
              <Button onClick={() => props.onProjection?.('compare')}>Compare</Button>
            </Show>
            <Button onClick={event => props.openRelation(props.pageId, 'reading', event.currentTarget)}>
              Add perspective
            </Button>
          </div>
        </Show>
        <props.RowRelations id={props.zoom ?? props.pageId} heading />
        <Show
          when={
            !props.zoom &&
            props.doc.root()?.kind === 'page' &&
            !props.doc.root()?.source &&
            props.doc.root()?.text.toLowerCase() !== 'fields' &&
            !props.type.error &&
            props.type()
          }
        >
          {value => (
            <Show when={value().members || value().fields.length || value().starting.length || value().card_templates}>
              <TemplateEditor
                type={value()}
                fields={props.definitions}
                workshop={props.workshop}
                onError={props.setMessage}
                onOpen={props.onOpen}
              />
              <RecipeSection typeId={value().page.id} workshop={props.workshop} onOpen={props.onOpen} />
            </Show>
          )}
        </Show>
        <Show when={props.doc.root()?.source && !props.positionZoom}>
          <SourceHeader
            doc={props.doc}
            workshop={props.workshop}
            resetItems={props.sourceResets}
            onOpen={props.onOpen}
            onError={props.setMessage}
            onDelete={props.onDelete}
            fields={props.definitions}
            compact={!!props.zoom}
            ready={props.pageReady && props.sourceApparatusReady}
            onReady={props.setSourceHeaderReady}
            onEditDetails={opener => {
              sourceDetailsOpener = opener;
              props.setSourceDetailsOpen(true);
            }}
            highlights={props.sourceHighlights}
            colors={props.sourceColors}
            onColors={props.setSourceColors}
            grouped={props.sourceGrouped}
            onGrouped={props.setSourceGrouped}
            fieldsVisible={props.sourceFieldsVisible}
            onFieldsVisible={visible => {
              props.setSourceFieldsVisible(visible);
              props.scheduleReport();
            }}
          />
        </Show>
        <Show when={props.doc.root()?.templateCards}>
          <CardSummary
            blockId={props.pageId}
            cards={[]}
            templateCount={props.doc.root()?.templateCards ?? 0}
            workshop={props.workshop}
            onOpen={props.onOpen}
          />
        </Show>
        <Show when={!props.zoom}>
          <props.projectSummary.Summary />
        </Show>
        <Show
          when={
            !props.zoom && (props.doc.root()?.task || props.doc.root()?.question || props.doc.root()?.citations.length)
          }
        >
          <div class="outline-root-capabilities outline-capability-metadata">
            <Show when={props.doc.root()?.task}>
              <TaskStatusButton
                task={props.doc.root()?.task ?? null}
                disabled={props.capabilities.busy(props.pageId)}
                onRestoreFocus={props.restoreFocus}
                onChange={status => props.capabilities.status(props.pageId, status)}
              />
              <props.TaskSummary id={props.pageId} />
              <Button
                class="outline-planning"
                onClick={event => props.capabilities.open(props.pageId, 'work', event.currentTarget)}
              >
                Work sessions
              </Button>
            </Show>
            <props.QuestionSummary id={props.pageId} />
            <For each={props.doc.root()?.citations}>
              {citation => (
                <CitationChip
                  citation={citation}
                  pageId={props.pageId}
                  workshop={props.workshop}
                  onOpen={props.onOpen}
                />
              )}
            </For>
          </div>
        </Show>
        <Show when={!props.zoom}>
          <QuestionParent
            info={props.doc.root()?.question}
            workshop={props.workshop}
            onOpen={props.onOpen}
            disabled={props.capabilities.busy(props.pageId)}
            onChange={anchor => props.capabilities.open(props.pageId, 'question-parent', anchor)}
            onRemove={() => {
              const question = props.doc.root()?.question;
              if (question) {
                const { parent: _, ...value } = question.state;
                props.capabilities.invoke(
                  props.capabilities.edit(props.pageId, { kind: 'question', id: props.pageId, value }),
                );
              }
            }}
          />
        </Show>
        <For each={props.doc.root()?.citations}>
          {citation => (
            <Show when={props.doc.root()?.text.trim() !== citation.quote.trim()}>
              <p class="outline-citation-quote" title={citation.quote}>
                {citation.quote}
              </p>
            </Show>
          )}
        </For>
        <Show when={props.capabilities.error(props.pageId)}>
          <p class="outline-capability-error" role="alert">
            {props.capabilities.error(props.pageId)}
          </p>
        </Show>
        <Show when={props.showArchived}>
          <p class="archive-notice">
            Showing archived atoms{' '}
            <button
              type="button"
              class="text-button"
              onClick={() => {
                props.setShowArchived(false);
                props.scheduleReport();
              }}
            >
              Hide archived
            </button>
          </p>
        </Show>
        <Show when={props.message}>
          <p class="outline-message" role="alert">
            {props.message}{' '}
            <button class="text-button" type="button" onClick={() => props.setMessage('')}>
              Dismiss
            </button>
          </p>
        </Show>
        <Show when={props.doc.status() === 'error' || props.doc.status() === 'missing'}>
          <p role="alert">{props.doc.statusMessage()}</p>
        </Show>
        <Show when={props.doc.status() === 'ready' && props.depth === 'gloss' && !props.zoom && !props.glossId}>
          <p class="empty-state">No gloss yet. Choose Gloss in the atom menu to write a one-line summary.</p>
        </Show>
        <Show when={!props.zoom && props.doc.root()?.kind === 'journal'}>
          <JournalHeader
            date={props.doc.root()!.text}
            journalPeriod={props.journalPeriod}
            workshop={props.workshop}
            onOpen={props.onOpen}
          />
        </Show>
        <props.FieldSlots id={props.pageId} />
        <Show when={!props.zoom && props.doc.root()?.spread}>
          <SpreadPane doc={props.doc} workshop={props.workshop} onActivate={props.onActivate} onOpen={props.onOpen} />
        </Show>
      </div>
      <Show when={!props.zoom && !props.idsCount && props.related?.heldReadings.length}>
        <HeldReadings rows={props.related?.heldReadings ?? []} workshop={props.workshop} onOpen={props.onOpen} />
      </Show>
      <Show when={!props.zoom && props.doc.root()?.question}>
        <Show when={props.branches.error}>
          <p class="error" role="alert">
            Couldn't load branches · {String(props.branches.error)}
          </p>
        </Show>
        <Show when={!props.branches.error}>
          <QuestionBranches rows={props.branches() ?? []} workshop={props.workshop} onOpen={props.onOpen} />
        </Show>
        <AssessmentJournal
          questionId={props.pageId}
          doc={props.doc}
          workshop={props.workshop}
          onOpen={props.onOpen}
          onWrite={() =>
            props.apply(
              { kind: 'writeAssessment', parentId: props.pageId, assessedOn: props.workshop.todayDate() },
              true,
            )
          }
        />
      </Show>
    </>
  );
}

export function OutlineEditingBar(props: {
  bindRef(element: HTMLDivElement): void;
  viewport: { bottom: number; left: number; width: number };
  composition: boolean;
  editing: string | null;
  doc: PageDocument;
  editor: () => PaneEditor | undefined;
  capabilities: OutlineCapabilityActions;
  roots(): string[];
  apply(intent: Edit, keepEditing?: boolean): EditResult | undefined;
  undo(): void;
  rowFocus(id: string, extend?: boolean, keepValue?: boolean): void;
}) {
  /** The accessory bar's Link and Tag write the opening of a reference or a tag at the caret; the completions take it from there. */
  function insertMark(mark: 'link' | 'tag') {
    const view = props.editor()?.view;
    if (!view || props.composition) return;
    const { from, to } = view.state.selection.main;
    if (mark === 'link') {
      const insert = from === to ? '[[]]' : `[[${view.state.sliceDoc(from, to)}]]`;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from === to ? from + 2 : from + insert.length },
        userEvent: 'input.type',
      });
    } else {
      const before = view.state.sliceDoc(Math.max(0, to - 1), to);
      const insert = `${before && !/\s/.test(before) ? ' ' : ''}#`;
      view.dispatch({
        changes: { from: to, insert },
        selection: { anchor: to + insert.length },
        userEvent: 'input.type',
      });
    }
    view.focus();
  }

  return (
    <Portal>
      <div
        ref={props.bindRef}
        class="outline-editing-bar"
        role="toolbar"
        aria-label="Outline editing"
        style={{
          top: `${props.viewport.bottom}px`,
          left: `${props.viewport.left}px`,
          width: `${props.viewport.width}px`,
        }}
        onPointerDown={event => event.preventDefault()}
        onMouseDown={event => event.preventDefault()}
      >
        <div class="outline-editing-tools glass">
          <Button
            icon="outdent"
            label="Outdent"
            disabled={props.composition}
            onClick={() => props.apply({ kind: 'outdent', ids: props.roots() }, true)}
          />
          <Button
            icon="indent"
            label="Indent"
            disabled={props.composition}
            onClick={() => props.apply({ kind: 'indent', ids: props.roots() }, true)}
          />
          <i class="outline-editing-divider" aria-hidden="true" />
          <Button
            icon="maketask"
            label="Make task"
            disabled={props.composition || !!props.doc.block(props.editing ?? '')?.task?.status}
            onClick={() => {
              if (props.editing) props.capabilities.invoke(props.capabilities.status(props.editing, 'todo'));
            }}
          />
          <Button icon="link" label="Link" disabled={props.composition} onClick={() => insertMark('link')} />
          <Button icon="tag" label="Tag" disabled={props.composition} onClick={() => insertMark('tag')} />
          <i class="outline-editing-divider" aria-hidden="true" />
          <Button
            icon="undo"
            label="Undo"
            disabled={props.composition || !props.doc.canUndo()}
            onClick={() => props.undo()}
          />
        </div>
        <Button
          class="outline-editing-done"
          icon="check"
          label="Done"
          onClick={() => {
            const id = props.editing;
            props.editor()?.view.contentDOM.blur();
            if (id) props.rowFocus(id, false, true);
          }}
        />
      </div>
    </Portal>
  );
}
