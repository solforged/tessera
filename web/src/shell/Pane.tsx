import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
} from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import type { IndexKind, NoteKind } from '../api/types';
import { blankCapture } from '../create/request';
import type { PageDocument } from '../document/contract';
import { titleKey } from '../document/title-key';
import { noteKindIcon } from '../notes/kinds';
import { displayTitle, readableText } from '../outline/names';
import { OutlinePane } from '../outline/OutlinePane';
import { PageMergePicker, builtInTagReason, pageMergeDisabledReason } from '../outline/PageMerge';
import { isReadingSubject, localPositionCount } from '../outline/read-register';
import { journalBarTitle } from '../tasks/journal-date';
import { civilDate, relativeDate } from '../tasks/relative-date';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { ListGroup, ListRow, PropertyRow } from '../ui/List';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { PaneChromeContext } from '../ui/NavBar';
import type { BarTitle, PaneChrome } from '../ui/NavBar';
import { Popup } from '../ui/Popup';
import { createPaneMotion, paneMotionIdentity, paneTargetIdentity } from '../ui/pane-motion';
import { opensBeside } from '../core/beside';
import type {
  AgendaViewState,
  CompareViewState,
  Depth,
  DirectoryViewState,
  FieldViewState,
  FieldsViewState,
  IndexViewState,
  LibraryViewState,
  OpenTarget,
  PageProjection,
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
import { depthLabels, depthStops } from '../core/contract';
import { DirectoryPane } from './DirectoryPane';
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
  const coverQuery = window.matchMedia('(max-width: 599px) and (pointer: coarse)');
  const [cover, setCover] = createSignal(coverQuery.matches);
  onMount(() => {
    const changed = () => setCover(coverQuery.matches);
    coverQuery.addEventListener('change', changed);
    onCleanup(() => coverQuery.removeEventListener('change', changed));
  });
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
  const [menu, setMenu] = createSignal<HTMLElement | null>(null);
  const [copyMessage, setCopyMessage] = createSignal('');
  createEffect(() => {
    pageId();
    setCopyMessage('');
  });
  async function copyPage(reference: boolean) {
    const id = pageId();
    if (!id) return;
    try {
      await navigator.clipboard.writeText(reference ? `[[${id}]]` : id);
      setCopyMessage(reference ? 'Copied reference' : 'Copied ID');
    } catch (error) {
      setCopyMessage(`Couldn't copy: ${String(error)}`);
    }
  }
  const [depthMenu, setDepthMenu] = createSignal<HTMLElement | null>(null);
  const [mergeFrom, setMergeFrom] = createSignal<{ id: string; text: string }>();
  let menuButton!: HTMLButtonElement;
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
    const document = workshop.notebook.open(id);
    setDoc(document);
    onCleanup(() => document.release());
  });
  const root = () => doc()?.root();
  const presentation = () => workshop.pagePresentations[pageId() ?? ''] ?? {};
  // A source with a snapshot reads as its book: Read opens the reader, so its page itself always shows the outline.
  const readableSource = () => !!root()?.source?.current_snapshot_id;
  const defaultProjection = createMemo<PageProjection>(() => {
    const page = doc();
    return page && isReadingSubject(page) ? 'read' : 'outline';
  });
  const projection = createMemo<PageProjection>(() => {
    if (readerTarget()) return 'read';
    if (outlineView().zoom) return 'outline';
    const value = outlineView().projection ?? presentation().projection ?? defaultProjection();
    return value === 'read' && readableSource() ? 'outline' : value;
  });
  createEffect(() => {
    if (current().target.kind !== 'page' || doc()?.status() !== 'ready' || outlineView().projection !== undefined)
      return;
    props.onViewChange({ ...outlineView(), projection: presentation().projection ?? defaultProjection() });
  });
  const readSubject = () => {
    const zoom = outlineView().zoom;
    const subject = zoom && doc()?.block(zoom)?.position?.subject_id;
    return subject ? workshop.notebook.lookup(subject)() : undefined;
  };
  const projectionReason = (value: PageProjection) => {
    if (value !== 'read' || readerTarget()) return undefined;
    if (doc()?.status() !== 'ready')
      return doc()?.status() === 'missing' || doc()?.status() === 'error'
        ? 'The atom is unavailable.'
        : 'Read is unavailable while the atom is loading.';
    const zoom = outlineView().zoom;
    if (!zoom) return root()?.kind === 'page' ? undefined : 'Only titled atoms have projections.';
    const block = doc()?.block(zoom);
    if (!block?.position) return 'Read is unavailable for this atom.';
    if (doc()?.isArchived(zoom)) return 'This perspective is archived. Restore it to use Read.';
    const subject = readSubject();
    if (subject === undefined) return 'The perspective’s subject is loading.';
    if (!subject || subject.archived) return 'The perspective’s subject is unavailable.';
    const page = subject.id === subject.page_id ? subject : workshop.notebook.lookup(subject.page_id)();
    if (page === undefined) return 'The perspective’s subject atom is loading.';
    if (!page || page.archived) return 'The perspective’s subject atom is unavailable.';
    if (page.kind !== 'page') return 'Read needs a titled subject. File this perspective under a concept or question.';
    return undefined;
  };
  const setProjection = (value: PageProjection, beside = false) => {
    const reader = readerTarget();
    if (reader) {
      if (value === 'read') return;
      const id = reader.sourceId,
        previous = props.session().entries[props.session().index - 1];
      workshop.onPagePresentation(id, { ...workshop.pagePresentations[id], projection: value });
      // The page the book was opened from is the way back to its outline.
      if (
        !beside &&
        pageIdOf(previous) === id &&
        !(previous!.view as ViewState).zoom &&
        (previous!.view as ViewState).projection === value
      )
        props.onTravel(-1);
      else props.onOpen({ kind: 'page', pageId: id }, beside);
      return;
    }
    if (projectionReason(value)) return;
    const zoom = outlineView().zoom;
    if (value === 'read' && !zoom && readableSource()) {
      props.onViewChange({ ...outlineView(), projection: 'outline' });
      props.onOpen({ kind: 'reader', sourceId: pageId()! }, beside);
      return;
    }
    if (value === 'read' && zoom) {
      const subject = readSubject()!;
      if (subject.page_id !== pageId()) {
        props.onOpen({ kind: 'page', pageId: subject.page_id, readAt: zoom }, false);
        return;
      }
      batch(() => {
        workshop.onPagePresentation(pageId()!, { ...presentation(), projection: 'read' });
        props.onRestoreView({
          ...outlineView(),
          projection: 'read',
          zoom: null,
          caret: { id: zoom, offset: 0 },
          scroll: { id: zoom, offset: 0 },
          reveal: zoom,
          edit: undefined,
        });
      });
      return;
    }
    batch(() => {
      props.onViewChange({ ...outlineView(), projection: value });
      workshop.onPagePresentation(pageId()!, { ...presentation(), projection: value });
    });
  };
  const pageStyle = () => ((presentation().bullets ?? root()?.kind === 'journal') ? 'bullets' : 'prose');
  const compareReason = () => {
    const page = doc();
    if (!readerTarget()) return outlineCommand('compare')?.disabledReason?.()?.replace(/\.$/, '');
    return page?.status() !== 'ready'
      ? 'Atom is unavailable'
      : localPositionCount(page) < 2
        ? 'Compare needs two perspectives on this atom'
        : undefined;
  };
  // Journals and other untitled roots have no projections, so their zooms carry neither the tabs nor Read's reason.
  const projectionTabsShown = () =>
    root()?.kind === 'page' || (!!outlineView().zoom && !!doc()?.block(outlineView().zoom!)?.position);
  const ProjectionTabs = () => (
    <div
      class="mode-tabs tab-strip page-projection-tabs"
      data-mode-panel=".outline-pane"
      role="tablist"
      aria-label="Atom projection"
    >
      <For each={['read', 'outline', 'compare'] as const}>
        {value => (
          <Button
            role="tab"
            aria-selected={projection() === value}
            disabled={value === 'read' ? !!projectionReason(value) : value === 'compare' && !!compareReason()}
            title={value === 'read' ? projectionReason(value) : value === 'compare' ? compareReason() : undefined}
            aria-description={
              value === 'read' ? projectionReason(value) : value === 'compare' ? compareReason() : undefined
            }
            onClick={event => setProjection(value, opensBeside(event))}
          >
            {value === 'read' ? 'Read' : value === 'outline' ? 'Outline' : 'Compare'}
          </Button>
        )}
      </For>
    </div>
  );
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
      ? displayTitle(root()!.text, id => workshop.notebook.lookup(id))
      : (root()?.text ?? 'Loading…'),
  );
  const readerTitle = createMemo(() => {
    const reader = readerTarget();
    const source = reader && workshop.notebook.lookup(reader.sourceId)();
    return source ? displayTitle(source.text, id => workshop.notebook.lookup(id)) : 'Reader';
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
            readableText(zoomed.text, id => workshop.notebook.lookup(id), zoomed.position?.deleted_holder) ||
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
  const rootCapability = (kind: 'task' | 'project') => outlineCommand(`${kind}-root`)?.run();
  const outlineCommand = (id: string) =>
    workshop.commands.list().find(command => command.id === `outline.${props.pane}.${id}`);
  const depth = (): Depth => outlineView().depth ?? 'full';
  // The dial shows on titled pages at their top level; a zoomed page always shows in full.
  const showDial = () => root()?.kind === 'page' && !outlineView().zoom && projection() === 'outline';
  // Read and Compare keep the dial's place, unseen, so switching projection never slides the tabs under the pointer.
  const dialPlace = () => root()?.kind === 'page' && !outlineView().zoom;
  // Journal days leave out description and the titled-page-only choices.
  const titled = () => root()?.kind !== 'journal';
  const stream = createMemo(() => root()?.manual_types.some(title => title.toLocaleLowerCase() === 'stream'));
  const makeItems = (): MenuItem[] => [
    ...(!root()?.task
      ? [
          {
            label: 'Task',
            icon: 'select',
            disabledReason: outlineCommand('task-root')?.disabledReason?.(),
            action: () => rootCapability('task'),
          } satisfies MenuItem,
        ]
      : []),
    ...(!root()?.project
      ? [
          {
            label: 'Project',
            icon: 'flag',
            disabledReason: outlineCommand('project-root')?.disabledReason?.(),
            action: () => rootCapability('project'),
          } satisfies MenuItem,
        ]
      : []),
    ...(titled() && !stream()
      ? [
          {
            label: 'Stream',
            icon: 'link',
            disabledReason: outlineCommand('stream-root')?.disabledReason?.(),
            action: () => outlineCommand('stream-root')?.run(),
          } satisfies MenuItem,
        ]
      : []),
    ...(titled() && !root()?.question
      ? [
          {
            label: 'Question',
            icon: 'question-open',
            disabledReason: root() ? undefined : 'Atom is still loading',
            action: () => {
              const result = doc()?.edit({
                kind: 'question',
                id: pageId()!,
                value: { unsettled: false, parked: false, accepted: null, review_on: null },
              });
              if (result && !result.ok) setCopyMessage(result.reason);
            },
          } satisfies MenuItem,
        ]
      : []),
  ];
  const pageInfo = () => workshop.notebook.roots().find(page => page.id === pageId());
  // The Info sheet names the created day the same way the page header does.
  const createdDate = () => {
    const page = pageInfo();
    if (!page) return '';
    return relativeDate(
      civilDate(page.created_at, workshop.notebook.settings()?.time_zone),
      workshop.notebook.todayDate(),
    );
  };
  const [info, setInfo] = createSignal(false);
  // A phone keeps the title in its bar; projection and depth remain explicit, checked choices here.
  const viewItems = (): MenuItem[] => [
    ...(['read', 'outline', 'compare'] as const).map(value => ({
      label: value === 'read' ? 'Read' : value === 'outline' ? 'Outline' : 'Compare',
      section: 'Projection',
      checked: projection() === value,
      disabledReason: value === 'read' ? projectionReason(value) : value === 'compare' ? compareReason() : undefined,
      action: () => setProjection(value),
    })),
    ...(dialPlace()
      ? depthStops.map(stop => ({
          label: depthLabels[stop],
          section: 'Depth',
          icon: `depth-${stop}` as const,
          checked: depth() === stop,
          disabledReason: projection() === 'outline' ? undefined : 'Depth applies to Outline',
          action: () => outlineCommand(`depth-${stop}`)?.run(),
        }))
      : []),
  ];
  const copyItem = (): MenuItem => ({
    label: 'Copy reference',
    icon: 'link',
    action: () => {
      void copyPage(true);
    },
  });
  const renameItems = (): MenuItem[] =>
    titled()
      ? [
          { label: 'Rename', icon: 'edit', action: props.onRename },
          {
            label: 'Merge into…',
            icon: 'merge',
            disabledReason: pageMergeDisabledReason(root(), doc()?.capabilities(pageId()!)),
            action: () => {
              const page = root();
              if (page) setMergeFrom({ id: page.id, text: page.text });
            },
          },
        ]
      : [];
  const pinItem = (): MenuItem => ({ label: props.pinned ? 'Unpin' : 'Pin', icon: 'pin', action: props.onPin });
  const descriptionItems = (): MenuItem[] =>
    titled()
      ? [
          {
            label: 'Description…',
            icon: 'note',
            submenu: () => ({
              title: 'Description',
              items: [
                {
                  label: 'Gloss',
                  icon: 'edit',
                  disabledReason: outlineCommand('gloss')?.disabledReason?.(),
                  action: () => outlineCommand('gloss')?.run(),
                },
                {
                  label: 'Add alias',
                  icon: 'edit',
                  disabledReason: outlineCommand('alias')?.disabledReason?.(),
                  action: () => outlineCommand('alias')?.run(),
                },
              ],
            }),
          },
        ]
      : [];
  const fieldItems = (): MenuItem[] => [
    {
      label: 'Add field…',
      icon: 'field',
      disabledReason: outlineCommand('add-field-root')?.disabledReason?.(),
      action: () => outlineCommand('add-field-root')?.run(),
    },
    {
      label: 'Tags…',
      icon: 'tag',
      disabledReason: outlineCommand('types-root')?.disabledReason?.(),
      action: () => outlineCommand('types-root')?.run(),
    },
  ];
  const capabilityItems = (): MenuItem[] => [
    ...(makeItems().length
      ? [
          {
            label: 'Make…',
            icon: 'plus',
            submenu: () => ({ title: 'Make', items: makeItems(), note: 'Each adds to this atom and keeps its text.' }),
          } satisfies MenuItem,
        ]
      : []),
    ...(root()?.task
      ? [
          {
            label: 'Task…',
            icon: 'select',
            disabledReason: outlineCommand('task-root')?.disabledReason?.(),
            action: () => rootCapability('task'),
          } satisfies MenuItem,
        ]
      : []),
    ...(root()?.project
      ? [
          {
            label: 'Project…',
            icon: 'flag',
            disabledReason: outlineCommand('project-root')?.disabledReason?.(),
            action: () => rootCapability('project'),
          } satisfies MenuItem,
        ]
      : []),
    ...(root()?.question
      ? [
          {
            label: 'Question…',
            icon: 'question-open',
            disabledReason: outlineCommand('question-root')?.disabledReason?.(),
            action: () => outlineCommand('question-root')?.run(),
          } satisfies MenuItem,
        ]
      : []),
    ...(stream()
      ? [
          {
            label: 'Stream…',
            icon: 'link',
            submenu: () => ({
              title: 'Stream',
              items: [
                {
                  label: 'Remove stream',
                  icon: 'trash',
                  danger: true,
                  disabledReason: outlineCommand('stream-root')?.disabledReason?.(),
                  action: () => outlineCommand('stream-root')?.run(),
                },
              ],
            }),
          } satisfies MenuItem,
        ]
      : []),
  ];
  const appearanceItem = (): MenuItem => ({
    label: 'Appearance…',
    icon: 'rows',
    submenu: () => ({
      title: 'Appearance',
      items: [
        ...(projection() === 'outline'
          ? [
              {
                label: pageStyle() === 'prose' ? 'Show bullets' : 'Hide bullets',
                icon: 'bullet',
                disabledReason: root() ? undefined : 'Atom is still loading',
                action: () =>
                  workshop.onPagePresentation(pageId()!, { ...presentation(), bullets: pageStyle() === 'prose' }),
              } satisfies MenuItem,
            ]
          : []),
        {
          label: outlineView().showArchived ? 'Hide archived' : 'Show archived',
          icon: 'archive',
          action: props.onArchived,
        },
      ],
    }),
  });
  const deleteItem = (): MenuItem => ({
    label: 'Delete atom…',
    icon: 'trash',
    danger: true,
    disabledReason: builtInTagReason(root()?.text ?? '', doc()?.capabilities(pageId()!), 'delete'),
    action: () => props.onDelete(menuButton),
  });
  const items = (): MenuItem[] => [
    copyItem(),
    ...renameItems().map((item, at) => (at ? item : { ...item, divider: true })),
    { ...pinItem(), divider: !titled() },
    { label: 'Open beside', icon: 'panes', disabledReason: props.besideReason, action: props.onPageBeside },
    ...descriptionItems().map(item => ({ ...item, divider: true })),
    ...fieldItems().map((item, at) => (at ? item : { ...item, divider: !titled() })),
    ...capabilityItems(),
    { ...appearanceItem(), divider: true },
    { ...deleteItem(), divider: true },
  ];
  // A phone's pull-down is groups of rows: the page's own acts, what it holds, what it can be, then Info and Delete. A day belongs
  // to the calendar, so a journal day offers no Delete.
  const phoneItems = (): MenuItem[] =>
    [
      [
        ...(projectionTabsShown()
          ? [{ label: 'View', icon: 'rows', submenu: () => ({ title: 'View', items: viewItems() }) } satisfies MenuItem]
          : []),
        copyItem(),
        ...(titled() && !root()?.source
          ? [
              {
                label: `Show in ${pageKinds()?.find(kind => kind.type_id)?.plural ?? ''} table`.replace('  ', ' '),
                icon: 'table',
                disabledReason: outlineCommand('open-table')?.disabledReason?.(),
                action: () => outlineCommand('open-table')?.run(),
              } satisfies MenuItem,
            ]
          : []),
        pinItem(),
      ],
      [...renameItems(), ...descriptionItems()],
      fieldItems(),
      [...capabilityItems(), appearanceItem()],
      pageInfo() ? [{ label: 'Info', icon: 'info', action: () => setInfo(true) } satisfies MenuItem] : [],
      titled() ? [deleteItem()] : [],
    ]
      .filter(group => group.length)
      .flatMap(group => group.map((item, at) => (at ? item : { ...item, divider: true })));
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
      (root()?.kind === 'journal' && root()?.text === workshop.notebook.todayDate() && !outlineView().zoom));
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
        data-page-style={pageStyle()}
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
                      readableText(block.text, id => workshop.notebook.lookup(id), block.position?.deleted_holder) ||
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
            <Show when={projectionTabsShown()}>
              <ProjectionTabs />
            </Show>
            <Show when={dialPlace()}>
              <div class="depth-dial" role="group" aria-label="Depth" data-held={showDial() ? undefined : ''}>
                <For each={depthStops}>
                  {stop => (
                    <button
                      type="button"
                      class="depth-stop"
                      aria-pressed={depth() === stop}
                      title={`${depthLabels[stop]} (${stop === 'gloss' ? '[' : stop === 'full' ? ']' : '[ ]'})`}
                      onClick={event => {
                        if (
                          depth() === stop &&
                          getComputedStyle(event.currentTarget.parentElement!.querySelector('.depth-label')!)
                            .display === 'none'
                        )
                          setDepthMenu(event.currentTarget);
                        else outlineCommand(`depth-${stop}`)?.run();
                      }}
                    >
                      <Icon name={`depth-${stop}`} />
                      <span class="visually-hidden">{depthLabels[stop]}</span>
                    </button>
                  )}
                </For>
                <span class="depth-label" aria-hidden="true">
                  {depthLabels[depth()]}
                </span>
              </div>
            </Show>
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
                  aria-expanded={!!menu()}
                  onClick={event => setMenu(value => (value ? null : event.currentTarget))}
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
        <Show when={copyMessage() && !menu()}>
          <p class="page-projection-reason" role="status">
            {copyMessage()}
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
                    projection={projection()}
                    onProjection={setProjection}
                    projectionReason={projectionReason}
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
                    notebook={workshop.notebook}
                  />
                }
              >
                <Match when={current().target.kind === 'table'}>
                  <TablePane
                    pane={props.pane}
                    neighbour={props.neighbour}
                    target={current().target as Extract<OpenTarget, { kind: 'table' }>}
                    view={snapshotView(current().view) as TableViewState}
                    notebook={workshop.notebook}
                    active={props.active}
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
                    onDeletePages={workshop.onDeleteSources}
                  />
                </Match>
                <Match when={current().target.kind === 'fields'}>
                  <FieldsPane
                    typeId={(current().target as Extract<OpenTarget, { kind: 'fields' }>).typeId}
                    view={snapshotView(current().view) as FieldsViewState}
                    notebook={workshop.notebook}
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
                    notebook={workshop.notebook}
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
                      notebook={workshop.notebook}
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
                      notebook={workshop.notebook}
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
                    notebook={workshop.notebook}
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
                      notebook={workshop.notebook}
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
                      notebook={workshop.notebook}
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
                      notebook={workshop.notebook}
                      onActivate={props.onActivate}
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
                    notebook={workshop.notebook}
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
                    notebook={workshop.notebook}
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
                    notebook={workshop.notebook}
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
                    notebook={workshop.notebook}
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
                    notebook={workshop.notebook}
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
        <Show when={menu()}>
          {anchor => (
            <Menu
              anchor={anchor()}
              label="Atom actions"
              title="Atom actions"
              context={
                root()?.kind === 'page' ? displayTitle(root()!.text, id => workshop.notebook.lookup(id)) : root()?.text
              }
              items={cover() ? phoneItems() : items()}
              onDismiss={() => setMenu(null)}
              header={
                <Show when={!cover() && pageInfo()}>
                  {page => (
                    <div class="page-menu-info">
                      <b>{page().id}</b>
                      <Button
                        class="bordered"
                        onClick={() => {
                          void copyPage(false);
                        }}
                      >
                        {copyMessage() === 'Copied ID' ? 'Copied' : 'Copy ID'}
                      </Button>
                      <span>
                        Created{' '}
                        {new Intl.DateTimeFormat('en-CA', {
                          timeZone: workshop.notebook.settings()?.time_zone,
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                        }).format(page().created_at)}
                      </span>
                      <Show when={copyMessage()}>
                        <span
                          class={copyMessage().startsWith("Couldn't copy:") ? 'error' : 'visually-hidden'}
                          role="status"
                        >
                          {copyMessage()}
                        </span>
                      </Show>
                    </div>
                  )}
                </Show>
              }
            />
          )}
        </Show>
        <Show when={info() && pageInfo()}>
          {page => (
            <Popup
              anchor={menuButton}
              placement="sheet"
              label="Info"
              title="Info"
              fitContent
              returnFocus={menuButton}
              onDismiss={() => {
                setInfo(false);
                setCopyMessage('');
              }}
            >
              <div class="page-info">
                <ListGroup>
                  <PropertyRow label="Created">{createdDate()}</PropertyRow>
                  <ListRow
                    icon="link"
                    detail={<span class="page-info-id">{page().id}</span>}
                    onClick={() => {
                      void copyPage(false);
                    }}
                  >
                    {copyMessage() === 'Copied ID' ? 'Copied ID' : 'Copy ID'}
                  </ListRow>
                </ListGroup>
              </div>
            </Popup>
          )}
        </Show>
        <Show when={depthMenu()}>
          {anchor => (
            <Menu
              anchor={anchor()}
              label="Depth"
              onDismiss={() => setDepthMenu(null)}
              items={depthStops.map(stop => ({
                label: depthLabels[stop],
                icon: `depth-${stop}` as const,
                checked: depth() === stop,
                action: () => outlineCommand(`depth-${stop}`)?.run(),
              }))}
            />
          )}
        </Show>
        <Show keyed when={mergeFrom()}>
          {from => (
            <PageMergePicker
              anchor={menuButton}
              notebook={workshop.notebook}
              from={from}
              onDismiss={() => setMergeFrom(undefined)}
              onMerged={id => {
                setMergeFrom(undefined);
                props.onOpen({ kind: 'page', pageId: id }, false);
              }}
            />
          )}
        </Show>
      </section>
    </PaneChromeContext.Provider>
  );
}
