import { For, Match, Show, Switch, createEffect, createMemo, createSignal, lazy, onCleanup, onMount } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import type { IndexKind, NoteKind } from '../api/types';
import { blankCapture } from '../create/request';
import type { PageDocument } from '../document/contract';
import { titleKey } from '../document/title-key';
import { noteKindIcon } from '../notes/kinds';
import { displayTitle, readableText } from '../outline/names';
import { OutlinePane } from '../outline/OutlinePane';
import { journalBarTitle } from '../tasks/journal-date';
import { isPhone } from '../ui/viewport';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { PaneChromeContext } from '../ui/NavBar';
import type { BarTitle, PaneChrome } from '../ui/NavBar';
import { createPaneMotion, paneMotionIdentity, paneTargetIdentity } from '../ui/pane-motion';
import { opensBeside } from '../core/beside';
import type {
  AgendaViewState,
  CompareViewState,
  DirectoryViewState,
  FieldViewState,
  FieldsViewState,
  IndexViewState,
  LibraryViewState,
  OpenTarget,
  PaneId,
  PaneSession,
  PaneView,
  ReaderViewState,
  ReviewViewState,
  RevisitsViewState,
  SettingsViewState,
  TableViewState,
  ViewState,
} from '../core/contract';
import { useWorkshop } from './context';
import { DirectoryPane } from './DirectoryPane';
import { createPageChrome } from './PageChrome';
import { paneModules } from './pane-modules';
import { copyView, pageIdOf, paneLabel, snapshotView } from './pane-state';
import type { VimMode } from './pane-state';
import './page-menu.css';

const TablePane = lazy(() => paneModules.table().then(module => ({ default: module.TablePane })));
const FieldsPane = lazy(() => paneModules.fields().then(module => ({ default: module.FieldsPane })));
const FieldPane = lazy(() => paneModules.field().then(module => ({ default: module.FieldPane })));
const CardTemplatesPane = lazy(() => paneModules.cards().then(module => ({ default: module.CardTemplatesPane })));
const SettingsPane = lazy(() => paneModules.settings().then(module => ({ default: module.SettingsPane })));
const HistoryPane = lazy(() => paneModules.history().then(module => ({ default: module.HistoryPane })));
const AgendaPane = lazy(() => paneModules.agenda().then(module => ({ default: module.AgendaPane })));
const ReviewPane = lazy(() => paneModules.review().then(module => ({ default: module.ReviewPane })));
const NotesReview = lazy(() => paneModules.revisits().then(module => ({ default: module.NotesReview })));
const LibraryPane = lazy(() => paneModules.library().then(module => ({ default: module.LibraryPane })));
const ReaderPane = lazy(() => paneModules.reader().then(module => ({ default: module.ReaderPane })));
const ComparePane = lazy(() => paneModules.compare().then(module => ({ default: module.ComparePane })));
const IndexPane = lazy(() => paneModules.index().then(module => ({ default: module.IndexPane })));
const SpreadPane = lazy(() => paneModules.spread().then(module => ({ default: module.SpreadPane })));

const vimLabels: Record<Exclude<VimMode, null>, string> = {
  insert: 'Insert',
  normal: 'Normal',
  visual: 'Visual',
  outline: 'Atoms',
};

const SAVE_NOTICE_DELAY = 1000;

export function Pane(props: {
  pane: PaneId;
  number: number;
  folded: boolean;
  grow: number;
  neighbour: boolean;
  session: Accessor<PaneSession>;
  active: boolean;
  immersive: boolean;
  onImmersive(immersive: boolean): void;
  renderDirectory(): JSX.Element;
  vimMode: VimMode;
  onVimMode(mode: VimMode): void;
  pinned: boolean;
  title?: string;
  noteKind?: IndexKind;
  besideReason?: string;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onTargetChange(target: OpenTarget): void;
  onPageBeside(): void;
  onViewChange(view: PaneView): void;
  onTravel(delta: number): void;
  onClose(): void;
  onChooseDate(anchor: HTMLElement): void;
  onShiftDate(delta: number): void;
  onPin(): void;
  onRename(): void;
  onDelete(anchor: HTMLElement, source?: boolean): void;
  onArchived(): void;
  onRestoreView(view: ViewState): void;
}) {
  const workshop = useWorkshop();
  const current = () => props.session().entries[props.session().index]!;
  const cover = isPhone;
  const pageId = createMemo(() => pageIdOf(current()));
  const readerTarget = () =>
    current().target.kind === 'reader' ? (current().target as Extract<OpenTarget, { kind: 'reader' }>) : undefined;
  // A reader keeps its source page open so the header's projection tabs can describe it.
  const docId = createMemo(() => pageId() ?? readerTarget()?.sourceId);
  const outlineView = () => current().view as ViewState;
  const [doc, setDoc] = createSignal<PageDocument>();
  const [pageKinds, setPageKinds] = createSignal<NoteKind[]>();
  const [librarySave, setLibrarySave] = createSignal<{ state: 'saved' | 'saving' | 'error'; message: string }>({
    state: 'saved',
    message: '',
  });
  const paneGeneration = createMemo(() => props.session().generation);
  createEffect(() => {
    paneGeneration();
    setLibrarySave({ state: 'saved', message: '' });
  });
  const [kindCreate, setKindCreate] = createSignal<{ label: string; run(anchor: HTMLElement): void }>();
  createEffect(() => {
    paneGeneration();
    setKindCreate(undefined);
  });
  let menuButton: HTMLButtonElement | undefined;
  let content!: HTMLDivElement;
  const motionIdentity = createMemo(() => paneTargetIdentity(current().target));
  createPaneMotion(
    () => content,
    createMemo(() => paneMotionIdentity(current().target)),
  );
  const [scrolled, setScrolled] = createSignal(false);
  createEffect(() => {
    paneGeneration();
    motionIdentity();
    setScrolled(false);
  });
  let header!: HTMLElement;
  onMount(() => {
    // Panes own their scroll containers; capture also sees scrolls from lazy-loaded surfaces. On a phone the nav bar's
    // inline title arrives once the page's large title (its first h1, or the element marked data-large-title) has gone
    // under the bar; where there is none it is a scroll past 48 px.
    let frame = 0,
      last: HTMLElement | undefined;
    const measure = () => {
      frame = 0;
      if (cover()) {
        const title = Array.from(content.querySelectorAll<HTMLElement>('[data-large-title], h1')).find(
          element => element.getClientRects().length > 0,
        );
        if (title) {
          setScrolled(title.getBoundingClientRect().bottom < header.getBoundingClientRect().bottom);
          return;
        }
      }
      if (last) setScrolled(last.scrollTop > 48);
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof HTMLElement)) return;
      last = event.target;
      frame ||= requestAnimationFrame(measure);
    };
    content.addEventListener('scroll', onScroll, { capture: true, passive: true });
    onCleanup(() => {
      content.removeEventListener('scroll', onScroll, true);
      cancelAnimationFrame(frame);
    });
  });
  createEffect(() => {
    const id = docId();
    setDoc(undefined);
    setPageKinds(undefined);
    if (!id) return;
    const document = workshop.workshop.open(id);
    setDoc(document);
    onCleanup(() => document.release());
  });
  const root = () => doc()?.root();
  const pageChrome = createPageChrome({
    pane: () => props.pane,
    workshop,
    session: props.session,
    doc,
    pageId,
    readerTarget,
    outlineView,
    pageKinds,
    pinned: () => props.pinned,
    besideReason: () => props.besideReason,
    menuButton: () => menuButton,
    onOpen: (target, beside) => props.onOpen(target, beside),
    onPageBeside: () => props.onPageBeside(),
    onViewChange: view => props.onViewChange(view),
    onTravel: delta => props.onTravel(delta),
    onPin: () => props.onPin(),
    onRename: () => props.onRename(),
    onDelete: (anchor, source) => props.onDelete(anchor, source),
    onArchived: () => props.onArchived(),
    onRestoreView: view => props.onRestoreView(view),
  });
  const { ProjectionTabs, DepthDial } = pageChrome;
  const breadcrumbs = createMemo(() => {
    const page = doc();
    const zoom = 'zoom' in current().view ? outlineView().zoom : null;
    if (!page || !zoom) return [];
    const result = [];
    let block = page.block(zoom);
    while (block && block.id !== page.pageId) {
      result.unshift(block);
      block = block.parentId ? page.block(block.parentId) : undefined;
    }
    return result;
  });
  const breadcrumbTitle = createMemo(() =>
    root()?.kind === 'page'
      ? displayTitle(root()!.text, id => workshop.workshop.lookup(id))
      : (root()?.text ?? 'Loading…'),
  );
  const readerTitle = createMemo(() => {
    const reader = readerTarget();
    const source = reader && workshop.workshop.lookup(reader.sourceId)();
    return source ? displayTitle(source.text, id => workshop.workshop.lookup(id)) : 'Reader';
  });
  // A phone's nav bar names the pane in prose once the large title has scrolled under it; a surface can say it itself (ui/NavBar.tsx).
  const [barEnd, setBarEnd] = createSignal<HTMLElement>();
  const [titleOverride, setTitleOverride] = createSignal<BarTitle>();
  const chrome: PaneChrome = { end: () => (cover() ? barEnd() : undefined), title: value => setTitleOverride(value) };
  const barTitle = (): BarTitle => {
    const override = titleOverride();
    if (override) return override;
    if (pageId()) {
      const zoomed = breadcrumbs().at(-1);
      if (zoomed)
        return {
          title:
            readableText(zoomed.text, id => workshop.workshop.lookup(id), zoomed.position?.deleted_holder) ||
            'Empty atom',
        };
      const page = root();
      return page?.kind === 'journal' && /^\d{4}-\d{2}-\d{2}$/.test(page.text)
        ? journalBarTitle(page.text)
        : { title: breadcrumbTitle() };
    }
    if (readerTarget()) return { title: readerTitle() };
    const target = current().target;
    return { title: target.kind === 'field' ? workshop.fieldName(target.fieldId) : (props.title ?? paneLabel(target)) };
  };
  // Typing queues edits in the local outbox for at most a second before sending, and most sends are
  // acknowledged within milliseconds; announcing each one would flash the header on every keystroke.
  // Saving… appears only when a send stays unacknowledged for longer than SAVE_NOTICE_DELAY.
  const sending = createMemo(() => doc()?.saveState() === 'saving');
  const [slowSave, setSlowSave] = createSignal(false);
  createEffect(() => {
    if (!sending()) {
      setSlowSave(false);
      return;
    }
    const timer = setTimeout(() => setSlowSave(true), SAVE_NOTICE_DELAY);
    onCleanup(() => clearTimeout(timer));
  });
  const saveState = () => doc()?.saveState();
  const status = () => {
    const state = saveState();
    return state === 'conflict'
      ? 'Conflict · Both versions kept'
      : state === 'error'
        ? 'Couldn’t save · Local changes kept'
        : state === 'offline'
          ? 'Offline'
          : 'Saving…';
  };
  // The place or kind the pane shows, in the same glyphs the sidebar uses.
  const kindIcon = (): IconName => {
    if (pageId()) {
      const page = root();
      if (page?.kind === 'journal') return 'today';
      if (page?.source) return 'library';
      if (page?.spread) return 'panes';
      if (page?.question) return noteKindIcon('question');
      if (page?.project) return noteKindIcon('project');
      const kind = pageKinds()
        ? pageKinds()!.find(kind => kind.type_id)
        : workshop.noteKinds?.find(
            kind => kind.type_id && page?.manual_types.some(title => titleKey(title) === titleKey(kind.name)),
          );
      return kind ? noteKindIcon(kind) : 'page';
    }
    const target = current().target;
    if (target.kind === 'index') return noteKindIcon(props.noteKind ?? target.key);
    if (target.kind === 'spread') return 'panes';
    if (target.kind === 'directory') return 'contents';
    if (target.kind === 'revisits') return 'history';
    if ((target.kind === 'fields' || target.kind === 'cards') && target.typeId)
      return noteKindIcon(props.noteKind ?? `type:${target.typeId}`);
    if (target.kind === 'table' && !target.viewId && props.noteKind) return noteKindIcon(props.noteKind);
    const kind = target.kind;
    return kind === 'agenda'
      ? 'agenda'
      : kind === 'review'
        ? 'review'
        : kind === 'library' || kind === 'reader'
          ? 'library'
          : kind === 'table'
            ? 'table'
            : kind === 'fields' || kind === 'field'
              ? 'field'
              : kind === 'settings'
                ? 'settings'
                : kind === 'history'
                  ? 'clock'
                  : kind === 'compare'
                    ? 'compare'
                    : 'page';
  };
  const tabRoot = () =>
    (!cover() || props.session().index === 0) &&
    (['agenda', 'review', 'library'].includes(current().target.kind) ||
      (root()?.kind === 'journal' && root()?.text === workshop.workshop.todayDate() && !outlineView().zoom));
  const showNew = () =>
    cover() &&
    (current().target.kind === 'index'
      ? !!kindCreate()
      : tabRoot() && (current().target.kind === 'agenda' || root()?.kind === 'journal'));
  const newLabel = () =>
    current().target.kind === 'index'
      ? (kindCreate()?.label ?? 'New')
      : current().target.kind === 'agenda'
        ? 'New task'
        : 'New';
  const create = (anchor: HTMLElement) => {
    if (current().target.kind === 'index') kindCreate()?.run(anchor);
    else
      workshop.onCreate(
        current().target.kind === 'agenda'
          ? {
              kind: 'task',
              text: '',
              into: { kind: 'journal' },
              lockKind: true,
              scheduledDate: (current().view as AgendaViewState).date,
            }
          : blankCapture(),
        anchor,
      );
  };
  return (
    <PaneChromeContext.Provider value={chrome}>
      <section
        class="pane"
        classList={{ active: props.active, immersive: props.immersive, folded: props.folded }}
        style={{ 'flex-grow': props.grow }}
        data-pane={props.pane}
        data-page-style={pageChrome.pageStyle()}
        aria-label={`Pane ${props.number}`}
        onPointerDown={props.onActivate}
        onFocusIn={props.onActivate}
      >
        <header
          ref={header}
          class="pane-header"
          classList={{ 'pane-scrolled': scrolled(), 'pane-tab-root': tabRoot() }}
        >
          <div class="pane-bar-start">
            <Show when={tabRoot()}>
              <Button
                class="pane-index nav-button"
                icon="contents"
                label="Index"
                onClick={() => props.onOpen({ kind: 'directory' }, false)}
              >
                <span>Index</span>
              </Button>
            </Show>
            <div class="pane-navigation">
              <Button
                class="pane-back nav-button"
                icon="left"
                label="Back"
                shortcut="⌃⇧H"
                disabled={props.session().index <= 0 && !(cover() && readerTarget())}
                onClick={() => {
                  const reader = cover() ? readerTarget() : undefined;
                  if (reader && props.session().index <= 0)
                    props.onOpen({ kind: 'page', pageId: reader.sourceId }, false);
                  else props.onTravel(-1);
                }}
              />
              <Button
                class="pane-forward"
                icon="right"
                label="Forward"
                shortcut="⌃⇧L"
                disabled={props.session().index >= props.session().entries.length - 1}
                onClick={() => props.onTravel(1)}
              />
            </div>
          </div>
          <Icon class="pane-kind" name={kindIcon()} />
          <Show when={workshop.split}>
            <span class="pane-number" aria-hidden="true">
              {props.number}
            </span>
          </Show>
          <Show when={cover()}>
            <Show
              when={barTitle().onClick}
              fallback={
                <div
                  class="pane-bar-title"
                  classList={{ 'pane-bar-title-glass': !!barTitle().glass }}
                  aria-hidden="true"
                >
                  <span>{barTitle().title}</span>
                  <Show when={barTitle().detail}>
                    <small>{barTitle().detail}</small>
                  </Show>
                </div>
              }
            >
              {open => (
                <button
                  type="button"
                  class="pane-bar-title pane-bar-title-action"
                  classList={{ 'pane-bar-title-glass': !!barTitle().glass }}
                  aria-haspopup="dialog"
                  onClick={event => open()(event.currentTarget)}
                >
                  <span>{barTitle().title}</span>
                  <Show when={barTitle().detail}>
                    <small>{barTitle().detail}</small>
                  </Show>
                </button>
              )}
            </Show>
          </Show>
          <Show when={pageId()}>
            <nav
              class="pane-breadcrumbs"
              aria-label="Atom breadcrumbs"
              style={{ visibility: root() ? undefined : 'hidden' }}
            >
              <Show when={root()?.source && !breadcrumbs().length}>
                <Button
                  class="breadcrumb-library"
                  title="Library"
                  onClick={event => props.onOpen({ kind: 'library' }, opensBeside(event))}
                >
                  Library
                </Button>
                <span class="breadcrumb-separator">/</span>
              </Show>
              <Button title={breadcrumbTitle()} onClick={() => props.onRestoreView({ ...outlineView(), zoom: null })}>
                {breadcrumbTitle()}
              </Button>
              <For each={breadcrumbs()}>
                {block => {
                  const title = createMemo(
                    () =>
                      readableText(block.text, id => workshop.workshop.lookup(id), block.position?.deleted_holder) ||
                      'Empty atom',
                  );
                  return (
                    <>
                      <span class="breadcrumb-separator">/</span>
                      <Button title={title()} onClick={() => props.onRestoreView({ ...outlineView(), zoom: block.id })}>
                        {title()}
                      </Button>
                    </>
                  );
                }}
              </For>
            </nav>
            <Show when={root()?.kind === 'journal'}>
              <nav class="journal-navigation" aria-label="Journal navigation">
                <Button icon="left" label="Previous journal day" onClick={() => props.onShiftDate(-1)} />
                <Button
                  class="journal-date nav-button"
                  icon="calendar"
                  label="Choose journal date"
                  aria-haspopup="dialog"
                  onClick={event => props.onChooseDate(event.currentTarget)}
                />
                <Button icon="right" label="Next journal day" onClick={() => props.onShiftDate(1)} />
              </nav>
            </Show>
            <Show when={pageChrome.projectionTabsShown()}>
              <ProjectionTabs />
            </Show>
            <DepthDial />
            <span class="pane-save-state" data-state={saveState()} title={doc()?.saveMessage()}>
              <Show
                when={saveState() !== 'saved' && saveState() !== 'queued' && (saveState() !== 'saving' || slowSave())}
                fallback={
                  <>
                    <span class="save-dot" />
                    <span class="visually-hidden">{saveState() === 'saved' ? 'Saved' : 'Saving…'}</span>
                  </>
                }
              >
                <Icon
                  name={
                    saveState() === 'offline'
                      ? 'offline'
                      : saveState() === 'error' || saveState() === 'conflict'
                        ? 'warning'
                        : 'saving'
                  }
                />
                {status()}
              </Show>
            </span>
            <Show when={workshop.vim && props.active}>
              <span
                class="vim-mode"
                data-mode={props.vimMode ?? 'outline'}
                title={
                  props.vimMode === 'insert'
                    ? 'Vim: typing into the atom'
                    : props.vimMode === 'visual'
                      ? 'Vim: selecting text'
                      : props.vimMode === 'normal'
                        ? 'Vim: commands inside the atom'
                        : 'Vim: moving between atoms'
                }
              >
                {vimLabels[props.vimMode ?? 'outline']}
              </span>
            </Show>
          </Show>
          <Show when={!pageId() && current().target.kind !== 'field'}>
            <Show
              when={
                current().target.kind === 'reader'
                  ? (current().target as Extract<OpenTarget, { kind: 'reader' }>)
                  : undefined
              }
              fallback={
                <span class="pane-breadcrumbs" title={props.title ?? paneLabel(current().target)}>
                  {props.title ?? paneLabel(current().target)}
                </span>
              }
            >
              {target => (
                <nav class="pane-breadcrumbs" aria-label="Source breadcrumbs">
                  <Button
                    class="breadcrumb-library"
                    title="Library"
                    onClick={event => props.onOpen({ kind: 'library' }, opensBeside(event))}
                  >
                    Library
                  </Button>
                  <span class="breadcrumb-separator">/</span>
                  <Button
                    title={readerTitle()}
                    onClick={event => props.onOpen({ kind: 'page', pageId: target().sourceId }, opensBeside(event))}
                  >
                    {readerTitle()}
                  </Button>
                </nav>
              )}
            </Show>
            <Show when={readerTarget() && root()?.kind === 'page'}>
              <ProjectionTabs />
            </Show>
          </Show>
          <Show when={current().target.kind === 'library'}>
            <span class="pane-save-state" data-state={librarySave().state} title={librarySave().message}>
              <Show
                when={librarySave().state !== 'saved'}
                fallback={
                  <>
                    <span class="save-dot" />
                    <span class="visually-hidden">Saved</span>
                  </>
                }
              >
                <Icon name={librarySave().state === 'error' ? 'warning' : 'saving'} />
                {librarySave().message || 'Saving…'}
              </Show>
            </span>
          </Show>
          <Show
            when={
              current().target.kind === 'field'
                ? (current().target as Extract<OpenTarget, { kind: 'field' }>)
                : undefined
            }
          >
            {target => (
              <>
                <nav class="pane-breadcrumbs" aria-label="Field breadcrumbs">
                  <Button title="Fields" onClick={event => props.onOpen({ kind: 'fields' }, opensBeside(event))}>
                    Fields
                  </Button>
                  <span class="breadcrumb-separator">/</span>
                  <Button
                    title={workshop.fieldName(target().fieldId)}
                    onClick={event => props.onOpen({ kind: 'field', fieldId: target().fieldId }, opensBeside(event))}
                  >
                    {workshop.fieldName(target().fieldId)}
                  </Button>
                </nav>
              </>
            )}
          </Show>
          <div class="pane-bar-end">
            <div class="pane-bar-surface" ref={setBarEnd} />
            <div class="pane-bar-group nav-group">
              <Show when={showNew()}>
                <Button
                  class="pane-new nav-button"
                  icon="plus"
                  label={newLabel()}
                  aria-haspopup="dialog"
                  onClick={event => create(event.currentTarget)}
                />
              </Show>
              <Show when={pageId()}>
                <Button
                  ref={menuButton}
                  class="page-menu-button nav-button"
                  icon="more"
                  label="Atom menu"
                  aria-haspopup="menu"
                  aria-expanded={!!pageChrome.menu()}
                  onClick={event => pageChrome.setMenu(value => (value ? null : event.currentTarget))}
                />
              </Show>
            </div>
          </div>
          <Show when={workshop.split}>
            <Button class="pane-secondary" icon="close" label="Close pane" shortcut="⌃⇧X" onClick={props.onClose} />
          </Show>
        </header>
        <Show when={doc()?.saveState() === 'error' || doc()?.saveState() === 'conflict'}>
          <div class="pane-error" role="alert">
            {doc()?.saveMessage()}
          </div>
        </Show>
        <Show when={pageChrome.copyMessage() && !pageChrome.menu()}>
          <p class="page-projection-reason" role="status">
            {pageChrome.copyMessage()}
          </p>
        </Show>
        <div ref={content} class="pane-content">
          <Show keyed when={props.session().generation}>
            {generation => (
              <Switch
                fallback={
                  <OutlinePane
                    pane={props.pane}
                    pageId={pageId()!}
                    projection={pageChrome.projection()}
                    onProjection={pageChrome.setProjection}
                    projectionReason={pageChrome.projectionReason}
                    journalPeriod={
                      current().target.kind === 'page'
                        ? (current().target as Extract<OpenTarget, { kind: 'page' }>).journalPeriod
                        : undefined
                    }
                    view={copyView(outlineView())}
                    onDelete={anchor => props.onDelete(anchor, true)}
                    onNoteKinds={kinds => {
                      if (generation === props.session().generation) setPageKinds(kinds);
                    }}
                    onViewChange={view => {
                      if (generation === props.session().generation) props.onViewChange(view);
                    }}
                    onOpen={(target, beside) => {
                      if (generation === props.session().generation) props.onOpen(target, beside);
                    }}
                    besideReason={props.besideReason}
                    active={props.active}
                    onActivate={() => {
                      if (
                        generation === props.session().generation &&
                        document.activeElement?.closest('.pane')?.getAttribute('data-pane') === props.pane
                      )
                        props.onActivate();
                    }}
                    vim={workshop.vim}
                    onVimMode={props.onVimMode}
                    commands={workshop.commands}
                    workshop={workshop.workshop}
                  />
                }
              >
                <Match when={current().target.kind === 'table'}>
                  <TablePane
                    pane={props.pane}
                    neighbour={props.neighbour}
                    target={current().target as Extract<OpenTarget, { kind: 'table' }>}
                    view={snapshotView(current().view) as TableViewState}
                    workshop={workshop.workshop}
                    active={props.active}
                    onActivate={props.onActivate}
                    onCreate={workshop.onCreate}
                    onOpen={(target, beside) => {
                      if (generation === props.session().generation) props.onOpen(target, beside);
                    }}
                    onTargetChange={target => {
                      if (generation === props.session().generation) props.onTargetChange(target);
                    }}
                    onViewChange={view => {
                      if (generation === props.session().generation) props.onViewChange(view);
                    }}
                    onDeletePages={workshop.onDeleteSources}
                  />
                </Match>
                <Match when={current().target.kind === 'fields'}>
                  <FieldsPane
                    typeId={(current().target as Extract<OpenTarget, { kind: 'fields' }>).typeId}
                    view={snapshotView(current().view) as FieldsViewState}
                    workshop={workshop.workshop}
                    onActivate={props.onActivate}
                    onOpen={(target, beside) => {
                      if (generation === props.session().generation) props.onOpen(target, beside);
                    }}
                    onViewChange={view => {
                      if (generation === props.session().generation) props.onViewChange(view);
                    }}
                  />
                </Match>
                <Match when={current().target.kind === 'field'}>
                  <FieldPane
                    target={current().target as Extract<OpenTarget, { kind: 'field' }>}
                    view={snapshotView(current().view) as FieldViewState}
                    workshop={workshop.workshop}
                    onActivate={props.onActivate}
                    onOpen={(target, beside) => {
                      if (generation === props.session().generation) props.onOpen(target, beside);
                    }}
                    onTargetChange={target => {
                      if (generation === props.session().generation) props.onTargetChange(target);
                    }}
                    onViewChange={view => {
                      if (generation === props.session().generation) props.onViewChange(view);
                    }}
                  />
                </Match>
                <Match
                  when={
                    current().target.kind === 'cards'
                      ? (current().target as Extract<OpenTarget, { kind: 'cards' }>)
                      : undefined
                  }
                >
                  {target => (
                    <CardTemplatesPane
                      typeId={target().typeId}
                      applyId={target().applyId}
                      view={snapshotView(current().view) as FieldsViewState}
                      workshop={workshop.workshop}
                      onActivate={props.onActivate}
                      onOpen={(next, beside) => {
                        if (generation === props.session().generation) props.onOpen(next, beside);
                      }}
                      onViewChange={view => {
                        if (generation === props.session().generation) props.onViewChange(view);
                      }}
                    />
                  )}
                </Match>
                <Match
                  when={
                    current().target.kind === 'settings'
                      ? (current().target as Extract<OpenTarget, { kind: 'settings' }>)
                      : undefined
                  }
                >
                  {target => (
                    <SettingsPane
                      pane={props.pane}
                      view={snapshotView(current().view) as SettingsViewState}
                      section={target().section}
                      deviceId={target().deviceId}
                      workshop={workshop.workshop}
                      onOpen={(target, beside) => {
                        if (generation === props.session().generation) props.onOpen(target, beside);
                      }}
                      onViewChange={view => {
                        if (generation === props.session().generation) props.onViewChange(view);
                      }}
                    />
                  )}
                </Match>
                <Match when={current().target.kind === 'history'}>
                  <HistoryPane
                    pane={props.pane}
                    view={snapshotView(current().view) as SettingsViewState}
                    workshop={workshop.workshop}
                    onOpen={(target, beside) => {
                      if (generation === props.session().generation) props.onOpen(target, beside);
                    }}
                    onViewChange={view => {
                      if (generation === props.session().generation) props.onViewChange(view);
                    }}
                  />
                </Match>
                <Match when={current().target.kind === 'directory'}>
                  <DirectoryPane
                    view={snapshotView(current().view) as DirectoryViewState}
                    atomCount={workshop.atomCount}
                    ready={workshop.directoryReady}
                    onViewChange={view => {
                      if (generation === props.session().generation) props.onViewChange(view);
                    }}
                  >
                    {props.renderDirectory()}
                  </DirectoryPane>
                </Match>
                <Match
                  when={
                    current().target.kind === 'compare'
                      ? (current().target as Extract<OpenTarget, { kind: 'compare' }>)
                      : undefined
                  }
                >
                  {target => (
                    <ComparePane
                      subjectId={target().subjectId}
                      view={snapshotView(current().view) as CompareViewState}
                      workshop={workshop.workshop}
                      onActivate={props.onActivate}
                      onOpen={(next, beside) => {
                        if (generation === props.session().generation) props.onOpen(next, beside);
                      }}
                      onViewChange={view => {
                        if (generation === props.session().generation) props.onViewChange(view);
                      }}
                    />
                  )}
                </Match>
                <Match
                  when={
                    current().target.kind === 'spread'
                      ? (current().target as Extract<OpenTarget, { kind: 'spread' }>)
                      : undefined
                  }
                >
                  {target => (
                    <SpreadPane
                      noteIds={target().noteIds}
                      workshop={workshop.workshop}
                      onActivate={props.onActivate}
                      onChange={noteIds => props.onTargetChange({ kind: 'spread', noteIds })}
                      onOpen={(next, beside) => {
                        if (generation === props.session().generation) props.onOpen(next, beside);
                      }}
                    />
                  )}
                </Match>
                <Match
                  when={
                    current().target.kind === 'index'
                      ? (current().target as Extract<OpenTarget, { kind: 'index' }>)
                      : undefined
                  }
                >
                  {target => (
                    <IndexPane
                      kindKey={target().key}
                      neighbour={props.neighbour}
                      kind={props.noteKind}
                      view={snapshotView(current().view) as IndexViewState}
                      workshop={workshop.workshop}
                      onActivate={props.onActivate}
                      onCreate={workshop.onCreate}
                      onNewAction={action => {
                        if (generation === props.session().generation) setKindCreate(action);
                      }}
                      onOpen={(next, beside) => {
                        if (generation === props.session().generation) props.onOpen(next, beside);
                      }}
                      onViewChange={view => {
                        if (generation === props.session().generation) props.onViewChange(view);
                      }}
                      onDeletePages={workshop.onDeleteSources}
                      onSpread={(noteIds, beside) => {
                        if (generation === props.session().generation)
                          props.onOpen({ kind: 'spread', noteIds }, beside);
                      }}
                    />
                  )}
                </Match>
                <Match when={current().target.kind === 'agenda'}>
                  <AgendaPane
                    pane={props.pane}
                    view={snapshotView(current().view) as AgendaViewState}
                    workshop={workshop.workshop}
                    active={props.active}
                    onActivate={props.onActivate}
                    onOpen={(target, beside) => {
                      if (generation === props.session().generation) props.onOpen(target, beside);
                    }}
                    onViewChange={view => {
                      if (generation === props.session().generation) props.onViewChange(view);
                    }}
                  />
                </Match>
                <Match when={current().target.kind === 'review'}>
                  <ReviewPane
                    pane={props.pane}
                    view={snapshotView(current().view) as ReviewViewState}
                    workshop={workshop.workshop}
                    commands={workshop.commands}
                    active={props.active}
                    onActivate={props.onActivate}
                    onCreate={workshop.onCreate}
                    onOpen={(target, beside) => {
                      if (generation === props.session().generation) props.onOpen(target, beside);
                    }}
                    onViewChange={view => {
                      if (generation === props.session().generation) props.onViewChange(view);
                    }}
                  />
                </Match>
                <Match when={current().target.kind === 'revisits'}>
                  <NotesReview
                    pane={props.pane}
                    view={snapshotView(current().view) as RevisitsViewState}
                    workshop={workshop.workshop}
                    commands={workshop.commands}
                    active={props.active}
                    onActivate={props.onActivate}
                    onOpen={(target, beside) => {
                      if (generation === props.session().generation) props.onOpen(target, beside);
                    }}
                    onViewChange={view => {
                      if (generation === props.session().generation) props.onViewChange(view);
                    }}
                  />
                </Match>
                <Match when={current().target.kind === 'library'}>
                  <LibraryPane
                    pane={props.pane}
                    view={snapshotView(current().view) as LibraryViewState}
                    workshop={workshop.workshop}
                    active={props.active}
                    neighbour={props.neighbour}
                    add={(current().target as Extract<OpenTarget, { kind: 'library' }>).add}
                    details={(current().target as Extract<OpenTarget, { kind: 'library' }>).details}
                    onAddOpened={() =>
                      props.onTargetChange({
                        kind: 'library',
                        tab: (current().target as Extract<OpenTarget, { kind: 'library' }>).tab,
                      })
                    }
                    onDetailsOpened={() =>
                      props.onTargetChange({
                        kind: 'library',
                        tab: (current().target as Extract<OpenTarget, { kind: 'library' }>).tab,
                      })
                    }
                    onSaveState={(state, message) => {
                      if (generation === props.session().generation) setLibrarySave({ state, message: message ?? '' });
                    }}
                    onActivate={props.onActivate}
                    onOpen={(target, beside) => {
                      if (generation === props.session().generation) props.onOpen(target, beside);
                    }}
                    onViewChange={view => {
                      if (generation === props.session().generation) props.onViewChange(view);
                    }}
                    onDeleteSources={workshop.onDeleteSources}
                  />
                </Match>
                <Match when={current().target.kind === 'reader'}>
                  <ReaderPane
                    pane={props.pane}
                    target={current().target as Extract<OpenTarget, { kind: 'reader' }>}
                    view={snapshotView(current().view) as ReaderViewState}
                    workshop={workshop.workshop}
                    active={props.active}
                    immersive={props.immersive}
                    onImmersive={props.onImmersive}
                    onActivate={props.onActivate}
                    onOpen={(target, beside) => {
                      if (generation === props.session().generation) props.onOpen(target, beside);
                    }}
                    onViewChange={view => {
                      if (generation === props.session().generation) props.onViewChange(view);
                    }}
                    onBack={() => {
                      if (props.session().index > 0) props.onTravel(-1);
                      else
                        props.onOpen(
                          {
                            kind: 'page',
                            pageId: (current().target as Extract<OpenTarget, { kind: 'reader' }>).sourceId,
                          },
                          false,
                        );
                    }}
                  />
                </Match>
              </Switch>
            )}
          </Show>
        </div>
        <pageChrome.Popups />
      </section>
    </PaneChromeContext.Provider>
  );
}
