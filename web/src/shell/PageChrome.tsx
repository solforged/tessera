import { For, Show, batch, createEffect, createMemo, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { NoteKind } from '../api/types';
import { opensBeside } from '../core/beside';
import type { Depth, OpenTarget, PageProjection, PaneId, PaneSession, PaneView, ViewState } from '../core/contract';
import { depthLabels, depthStops } from '../core/contract';
import type { PageDocument } from '../document/contract';
import { displayTitle } from '../outline/names';
import { PageMergePicker, builtInTagReason, pageMergeDisabledReason } from '../outline/PageMerge';
import { isReadingSubject, localPositionCount } from '../outline/read-register';
import { civilDate, relativeDate } from '../tasks/relative-date';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { ListGroup, ListRow, PropertyRow } from '../ui/List';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { isPhone } from '../ui/viewport';
import type { WorkshopShell } from './context';
import { pageIdOf } from './pane-state';

export interface PageChromeOptions {
  pane: Accessor<PaneId>;
  workshop: WorkshopShell;
  session: Accessor<PaneSession>;
  doc: Accessor<PageDocument | undefined>;
  pageId: Accessor<string | undefined>;
  readerTarget: Accessor<Extract<OpenTarget, { kind: 'reader' }> | undefined>;
  outlineView: Accessor<ViewState>;
  pageKinds: Accessor<NoteKind[] | undefined>;
  pinned: Accessor<boolean>;
  besideReason: Accessor<string | undefined>;
  menuButton: Accessor<HTMLButtonElement | undefined>;
  onOpen(target: OpenTarget, beside: boolean): void;
  onPageBeside(): void;
  onViewChange(view: PaneView): void;
  onTravel(delta: number): void;
  onPin(): void;
  onRename(): void;
  onDelete(anchor: HTMLElement, source?: boolean): void;
  onArchived(): void;
  onRestoreView(view: ViewState): void;
}

/** Page- and source-specific header controls (projection tabs, depth dial, and page menu/info/merge popups). */
export function createPageChrome(options: PageChromeOptions) {
  const { workshop } = options;
  const cover = isPhone;
  const current = () => options.session().entries[options.session().index]!;
  const root = () => options.doc()?.root();
  const presentation = () => workshop.pagePresentations[options.pageId() ?? ''] ?? {};

  const [menu, setMenu] = createSignal<HTMLElement | null>(null);
  const [depthMenu, setDepthMenu] = createSignal<HTMLElement | null>(null);
  const [info, setInfo] = createSignal(false);
  const [mergeFrom, setMergeFrom] = createSignal<{ id: string; text: string }>();
  const [copyMessage, setCopyMessage] = createSignal('');
  createEffect(() => {
    options.pageId();
    setCopyMessage('');
  });

  async function copyPage(reference: boolean) {
    const id = options.pageId();
    if (!id) return;
    try {
      await navigator.clipboard.writeText(reference ? `[[${id}]]` : id);
      setCopyMessage(reference ? 'Copied reference' : 'Copied ID');
    } catch (error) {
      setCopyMessage(`Couldn't copy: ${String(error)}`);
    }
  }

  const outlineCommand = (id: string) =>
    workshop.commands.list().find(command => command.id === `outline.${options.pane()}.${id}`);
  const rootCapability = (kind: 'task' | 'project') => outlineCommand(`${kind}-root`)?.run();

  // A source with a snapshot reads as its book: Read opens the reader, so its page itself always shows the outline.
  const readableSource = () => !!root()?.source?.current_snapshot_id;
  const defaultProjection = createMemo<PageProjection>(() => {
    const page = options.doc();
    return page && isReadingSubject(page) ? 'read' : 'outline';
  });
  const projection = createMemo<PageProjection>(() => {
    if (options.readerTarget()) return 'read';
    if (options.outlineView().zoom) return 'outline';
    const value = options.outlineView().projection ?? presentation().projection ?? defaultProjection();
    return value === 'read' && readableSource() ? 'outline' : value;
  });
  createEffect(() => {
    if (
      current().target.kind !== 'page' ||
      options.doc()?.status() !== 'ready' ||
      options.outlineView().projection !== undefined
    )
      return;
    options.onViewChange({ ...options.outlineView(), projection: presentation().projection ?? defaultProjection() });
  });

  const readSubject = () => {
    const zoom = options.outlineView().zoom;
    const subject = zoom && options.doc()?.block(zoom)?.position?.subject_id;
    return subject ? workshop.workshop.lookup(subject)() : undefined;
  };
  const projectionReason = (value: PageProjection) => {
    if (value !== 'read' || options.readerTarget()) return undefined;
    if (options.doc()?.status() !== 'ready')
      return options.doc()?.status() === 'missing' || options.doc()?.status() === 'error'
        ? 'The note is unavailable.'
        : 'Read is unavailable while the note is loading.';
    const zoom = options.outlineView().zoom;
    if (!zoom) return root()?.kind === 'page' ? undefined : 'Only titled notes have projections.';
    const block = options.doc()?.block(zoom);
    if (!block?.position) return 'Read is unavailable for this note.';
    if (options.doc()?.isArchived(zoom)) return 'This perspective is archived. Restore it to use Read.';
    const subject = readSubject();
    if (subject === undefined) return 'The perspective’s subject is loading.';
    if (!subject || subject.archived) return 'The perspective’s subject is unavailable.';
    const page = subject.id === subject.page_id ? subject : workshop.workshop.lookup(subject.page_id)();
    if (page === undefined) return 'The perspective’s subject note is loading.';
    if (!page || page.archived) return 'The perspective’s subject note is unavailable.';
    if (page.kind !== 'page') return 'Read needs a titled subject. File this perspective under a concept or question.';
    return undefined;
  };
  const setProjection = (value: PageProjection, beside = false) => {
    const reader = options.readerTarget();
    if (reader) {
      if (value === 'read') return;
      const id = reader.sourceId,
        previous = options.session().entries[options.session().index - 1];
      workshop.onPagePresentation(id, { ...workshop.pagePresentations[id], projection: value });
      // The page the book was opened from is the way back to its outline.
      if (
        !beside &&
        pageIdOf(previous) === id &&
        !(previous!.view as ViewState).zoom &&
        (previous!.view as ViewState).projection === value
      )
        options.onTravel(-1);
      else options.onOpen({ kind: 'page', pageId: id }, beside);
      return;
    }
    if (projectionReason(value)) return;
    const zoom = options.outlineView().zoom;
    if (value === 'read' && !zoom && readableSource()) {
      options.onViewChange({ ...options.outlineView(), projection: 'outline' });
      options.onOpen({ kind: 'reader', sourceId: options.pageId()! }, beside);
      return;
    }
    if (value === 'read' && zoom) {
      const subject = readSubject()!;
      if (subject.page_id !== options.pageId()) {
        options.onOpen({ kind: 'page', pageId: subject.page_id, readAt: zoom }, false);
        return;
      }
      batch(() => {
        workshop.onPagePresentation(options.pageId()!, { ...presentation(), projection: 'read' });
        options.onRestoreView({
          ...options.outlineView(),
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
      options.onViewChange({ ...options.outlineView(), projection: value });
      workshop.onPagePresentation(options.pageId()!, { ...presentation(), projection: value });
    });
  };

  const pageStyle = () => ((presentation().bullets ?? root()?.kind === 'journal') ? 'bullets' : 'prose');
  const compareReason = () => {
    const page = options.doc();
    if (!options.readerTarget()) return outlineCommand('compare')?.disabledReason?.()?.replace(/\.$/, '');
    return page?.status() !== 'ready'
      ? 'Note is unavailable'
      : localPositionCount(page) < 2
        ? 'Compare needs two perspectives on this note'
        : undefined;
  };
  // Journals and other untitled roots have no projections, so their zooms carry neither the tabs nor Read's reason.
  const projectionTabsShown = () =>
    root()?.kind === 'page' ||
    (!!options.outlineView().zoom && !!options.doc()?.block(options.outlineView().zoom!)?.position);

  const depth = (): Depth => options.outlineView().depth ?? 'full';
  // The dial shows on titled pages at their top level; a zoomed page always shows in full.
  const showDial = () => root()?.kind === 'page' && !options.outlineView().zoom && projection() === 'outline';
  // Read and Compare keep the dial's place, unseen, so switching projection never slides the tabs under the pointer.
  const dialPlace = () => root()?.kind === 'page' && !options.outlineView().zoom;
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
            disabledReason: root() ? undefined : 'Note is still loading',
            action: () => {
              const result = options.doc()?.edit({
                kind: 'question',
                id: options.pageId()!,
                value: { unsettled: false, parked: false, accepted: null, review_on: null },
              });
              if (result && !result.ok) setCopyMessage(result.reason);
            },
          } satisfies MenuItem,
        ]
      : []),
  ];

  const pageInfo = () => workshop.workshop.roots().find(page => page.id === options.pageId());
  const createdDate = () => {
    const page = pageInfo();
    if (!page) return '';
    return relativeDate(
      civilDate(page.created_at, workshop.workshop.settings()?.time_zone),
      workshop.workshop.todayDate(),
    );
  };

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
          { label: 'Rename', icon: 'edit', action: options.onRename },
          {
            label: 'Merge into…',
            icon: 'merge',
            disabledReason: pageMergeDisabledReason(root(), options.doc()?.capabilities(options.pageId()!)),
            action: () => {
              const page = root();
              if (page) setMergeFrom({ id: page.id, text: page.text });
            },
          },
        ]
      : [];
  const pinItem = (): MenuItem => ({ label: options.pinned() ? 'Unpin' : 'Pin', icon: 'pin', action: options.onPin });
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
            submenu: () => ({ title: 'Make', items: makeItems(), note: 'Each adds to this note and keeps its text.' }),
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
                disabledReason: root() ? undefined : 'Note is still loading',
                action: () =>
                  workshop.onPagePresentation(options.pageId()!, {
                    ...presentation(),
                    bullets: pageStyle() === 'prose',
                  }),
              } satisfies MenuItem,
            ]
          : []),
        {
          label: options.outlineView().showArchived ? 'Hide archived' : 'Show archived',
          icon: 'archive',
          action: options.onArchived,
        },
      ],
    }),
  });
  const tableItem = (): MenuItem[] =>
    titled() && !root()?.source && options.pageKinds()?.some(kind => kind.type_id)
      ? [
          {
            label: `Show in ${options.pageKinds()?.find(kind => kind.type_id)?.plural ?? ''} table`.replace('  ', ' '),
            icon: 'table',
            disabledReason: outlineCommand('open-table')?.disabledReason?.(),
            action: () => outlineCommand('open-table')?.run(),
          } satisfies MenuItem,
        ]
      : [];
  const deleteItem = (): MenuItem => ({
    label: 'Delete note…',
    icon: 'trash',
    danger: true,
    disabledReason: builtInTagReason(root()?.text ?? '', options.doc()?.capabilities(options.pageId()!), 'delete'),
    action: () => {
      const anchor = options.menuButton();
      if (anchor) options.onDelete(anchor);
    },
  });

  const items = (): MenuItem[] => [
    copyItem(),
    ...tableItem(),
    ...renameItems().map((item, at) => (at ? item : { ...item, divider: true })),
    { ...pinItem(), divider: !titled() },
    { label: 'Open beside', icon: 'panes', disabledReason: options.besideReason(), action: options.onPageBeside },
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
                label: `Show in ${options.pageKinds()?.find(kind => kind.type_id)?.plural ?? ''} table`.replace(
                  '  ',
                  ' ',
                ),
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

  const ProjectionTabs = () => (
    <div
      class="mode-tabs tab-strip page-projection-tabs"
      data-mode-panel=".outline-pane"
      role="tablist"
      aria-label="Note projection"
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

  const DepthDial = () => (
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
                  getComputedStyle(event.currentTarget.parentElement!.querySelector('.depth-label')!).display === 'none'
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
  );

  const Popups = () => (
    <>
      <Show when={menu()}>
        {anchor => (
          <Menu
            anchor={anchor()}
            label="Note actions"
            title="Note actions"
            context={
              root()?.kind === 'page' ? displayTitle(root()!.text, id => workshop.workshop.lookup(id)) : root()?.text
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
                        timeZone: workshop.workshop.settings()?.time_zone,
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
            anchor={options.menuButton()!}
            placement="sheet"
            label="Info"
            title="Info"
            fitContent
            returnFocus={options.menuButton()}
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
            anchor={options.menuButton()!}
            workshop={workshop.workshop}
            from={from}
            onDismiss={() => setMergeFrom(undefined)}
            onMerged={id => {
              setMergeFrom(undefined);
              options.onOpen({ kind: 'page', pageId: id }, false);
            }}
          />
        )}
      </Show>
    </>
  );

  return {
    projection,
    setProjection,
    projectionReason,
    projectionTabsShown,
    pageStyle,
    menu,
    setMenu,
    copyMessage,
    ProjectionTabs,
    DepthDial,
    Popups,
  };
}
