import { For, Index, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Block, IndexKind, NoteIndex, NoteKind, Shelf, View } from '../api/types';
import { opensBeside } from '../core/beside';
import type { HistoryEntry, OpenTarget, PaneId } from '../core/contract';
import { deskTarget } from '../desk/query';
import type { WorkshopClient } from '../document/contract';
import { indexKindTarget, kindLabel, noteKindIcon, shelves, tagOnly } from '../notes/kinds';
import { WorkshopSwitcher } from '../settings/NotebookSwitcher';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { MenuItem } from '../ui/Menu';
import { isPhone } from '../ui/viewport';
import { shortDay } from '../workflows/desk-counts';
import type { DeskCounts } from '../workflows/desk-counts';
import { PageLinks } from './PageLinks';
import { PhoneIndex } from './PhoneIndex';
import { ViewLinks } from './ViewLinks';
import { pageIdOf } from './pane-state';

/** Hide an unfiltered default view whose name duplicates its parent kind right above it. */
function redundantKindView(view: View, kind: IndexKind): boolean {
  return (
    !view.query.text &&
    !view.query.filters.length &&
    view.name.trim().toLocaleLowerCase() === kindLabel(kind).trim().toLocaleLowerCase()
  );
}

export interface SidebarNavProps {
  owner: Accessor<PaneId>;
  directory?: boolean;
  workshop: WorkshopClient;
  todayDate: Accessor<string>;
  counts: Accessor<DeskCounts | undefined>;
  activeEntry: Accessor<HistoryEntry | undefined>;
  activeRoot: Accessor<Block | undefined>;
  activeKindKey: Accessor<string | undefined>;
  activeTypeId: Accessor<string | null>;
  activeViewId: Accessor<string | undefined>;
  journalDate(pane: PaneId): string;
  index: Accessor<NoteIndex | undefined>;
  views: Accessor<View[] | undefined>;
  pinnedRoots: Accessor<Block[]>;
  pinnedViews: Accessor<string[]>;
  pinnedViewList: Accessor<View[]>;
  otherViews: Accessor<View[]>;
  looseViews: Accessor<View[]>;
  recentRoots: Accessor<Block[]>;
  shelfKinds: Accessor<Partial<Record<Shelf, IndexKind[]>>>;
  viewInKind(view: View, kind: NoteKind): boolean;
  sectionNumber(section: 'pinned' | 'index' | 'views' | 'recent'): string;
  onToday(owner: PaneId, beside: boolean): void;
  onOpen(target: OpenTarget, beside: boolean, owner: PaneId): void;
  onOpenView(view: View, beside: boolean, owner: PaneId): void;
  onPinView(id: string): void;
  onNewView(anchor: HTMLElement, owner: PaneId): void;
  onQuestionsMenu(anchor: HTMLElement): void;
  onError(reason: unknown): void;
}

/** Shared navigation for the desktop/tablet sidebar and the phone Directory pane. */
export function SidebarNav(props: SidebarNavProps) {
  const cover = isPhone;
  const phoneDirectory = () => !!props.directory && cover();
  const onOpen = (target: OpenTarget, beside = false) => props.onOpen(target, beside, props.owner());
  const onOpenView = (view: View, beside: boolean) => props.onOpenView(view, beside, props.owner());
  const viewMenuItems = (view: View): MenuItem[] => [
    {
      label: props.pinnedViews().includes(view.id) ? 'Unpin view' : 'Pin view',
      icon: 'pin',
      action: () => props.onPinView(view.id),
    },
  ];
  const revisits = () => (
    <Button
      icon="history"
      class={props.activeEntry()?.target.kind === 'revisits' ? 'selected' : ''}
      aria-label={`Revisits · ${props.counts()?.revisits ?? 0} to revisit`}
      onClick={event => onOpen({ kind: 'revisits' }, opensBeside(event))}
    >
      <span>Revisits</span>
      <Show when={props.counts()?.revisits}>
        {due => (
          <span class="desk-count" title={`${due()} to revisit`}>
            {due()}
          </span>
        )}
      </Show>
    </Button>
  );
  const fields = () => (
    <Button
      class={`index-kind ${props.activeEntry()?.target.kind === 'fields' && !(props.activeEntry()?.target as Extract<OpenTarget, { kind: 'fields' }> | undefined)?.typeId ? 'selected' : ''}`}
      icon="field"
      title="Fields"
      aria-current={
        props.activeEntry()?.target.kind === 'fields' &&
        !(props.activeEntry()?.target as Extract<OpenTarget, { kind: 'fields' }> | undefined)?.typeId
          ? 'page'
          : undefined
      }
      onClick={event => onOpen({ kind: 'fields' }, opensBeside(event))}
    >
      <span>Fields</span>
      <span class="desk-count">{props.index()?.fields.toLocaleString()}</span>
    </Button>
  );
  const kindViews = (kind: IndexKind) =>
    props.otherViews().filter(view => props.viewInKind(view, kind) && !redundantKindView(view, kind));
  const kindRow = (kind: Accessor<IndexKind>) => (
    <>
      <div class="index-kind-row">
        <Button
          class={`index-kind ${props.activeKindKey() === kind().key || (tagOnly(kind()) && props.activeTypeId() === kind().type_id) ? 'selected' : ''} ${kind().count || kind().tagged_block_count ? '' : 'empty'}`}
          icon={noteKindIcon(kind())}
          title={kindLabel(kind())}
          onClick={event => onOpen(indexKindTarget(kind()), opensBeside(event))}
        >
          <span>{kindLabel(kind())}</span>
          <Show when={kind().count || kind().tagged_block_count}>
            {count => <span class="desk-count">{count().toLocaleString()}</span>}
          </Show>
        </Button>
        <Show
          when={
            kind().key === 'question' && (kind().count || kind().tagged_block_count || kindViews(kind()).length > 0)
          }
        >
          <Button
            icon="more"
            label="Questions menu"
            aria-haspopup="menu"
            onClick={event => props.onQuestionsMenu(event.currentTarget)}
          />
        </Show>
      </div>
      <Show when={kindViews(kind()).length}>
        <div class="index-views">
          <ViewLinks
            views={kindViews(kind())}
            pinned={false}
            activeId={props.activeViewId()}
            onOpen={onOpenView}
            onPin={props.onPinView}
          />
        </div>
      </Show>
    </>
  );

  return (
    <Show
      when={phoneDirectory()}
      fallback={
        <>
          <nav class="primary-navigation" aria-label="Workshop">
            <Button
              data-phone-tab
              icon="today"
              title="Today (⌃⇧J)"
              class={
                props.activeRoot()?.kind === 'journal' && props.activeRoot()?.text === props.todayDate()
                  ? 'selected'
                  : ''
              }
              onClick={event => props.onToday(props.owner(), opensBeside(event))}
            >
              <span>Today</span>
              <span class="desk-count">{shortDay(props.todayDate())}</span>
            </Button>
            <Button
              data-phone-tab
              icon="agenda"
              class={props.activeEntry()?.target.kind === 'agenda' ? 'selected' : ''}
              onClick={event => onOpen({ kind: 'agenda', date: props.journalDate(props.owner()) }, opensBeside(event))}
            >
              <span>Agenda</span>
              <Show when={(props.counts()?.planned ?? 0) + (props.counts()?.overdue ?? 0)}>
                {total => (
                  <span
                    class={`desk-count ${props.counts()!.overdue ? 'late' : ''}`}
                    title={`${total()} to do: ${props.counts()!.planned} today · ${props.counts()!.overdue} overdue`}
                  >
                    {total()}
                  </span>
                )}
              </Show>
            </Button>
            {revisits()}
            <Button
              data-phone-tab
              icon="review"
              class={props.activeEntry()?.target.kind === 'review' ? 'selected' : ''}
              aria-label={`Review · ${props.counts()?.cards ?? 0} cards`}
              onClick={event => onOpen({ kind: 'review' }, opensBeside(event))}
            >
              <span>Review</span>
              <Show when={props.counts()?.cards}>
                {due => (
                  <span class="desk-count" title={`${due()} cards`}>
                    {due()}
                  </span>
                )}
              </Show>
            </Button>
            <Button
              data-phone-tab
              icon="library"
              class={props.activeEntry()?.target.kind === 'library' ? 'selected' : ''}
              onClick={event => onOpen({ kind: 'library' }, opensBeside(event))}
            >
              <span>Library</span>
              <Show when={props.counts()?.highlights}>
                {highlights => (
                  <span
                    class="desk-count"
                    title={`${highlights()} unprocessed ${highlights() === 1 ? 'highlight' : 'highlights'}`}
                  >
                    {highlights()}
                  </span>
                )}
              </Show>
            </Button>
          </nav>
          <div class="sidebar-scroll">
            <Show when={props.pinnedRoots().length || props.pinnedViewList().length}>
              <section class="page-list" aria-label="Pinned">
                <h2>
                  <span class="section-number">{props.sectionNumber('pinned')}</span>Pinned
                  <span class="section-rule" />
                  <span class="section-count">{props.pinnedRoots().length + props.pinnedViewList().length}</span>
                </h2>
                <PageLinks
                  roots={props.pinnedRoots()}
                  workshop={props.workshop}
                  activeId={pageIdOf(props.activeEntry())}
                  onOpen={onOpen}
                />
                <ViewLinks
                  views={props.pinnedViewList()}
                  pinned
                  activeId={props.activeViewId()}
                  onOpen={onOpenView}
                  onPin={props.onPinView}
                />
              </section>
            </Show>
            <Show when={props.index()?.kinds.length}>
              <section class="page-list index-list" aria-label="Index">
                <h2>
                  <span class="section-number">{props.sectionNumber('index')}</span>
                  <button
                    type="button"
                    class="index-directory-link"
                    aria-current={props.activeKindKey() === 'all' ? 'page' : undefined}
                    title="Open Index"
                    onClick={event => onOpen({ kind: 'index', key: 'all' }, opensBeside(event))}
                  >
                    Index
                  </button>
                  <span class="section-rule" />
                  <Show when={props.index()!.notes}>
                    {notes => (
                      <span
                        class="section-count"
                        title={`${notes().toLocaleString()} ${notes() === 1 ? 'note' : 'notes'} filed under ${props.index()!.kinds.length.toLocaleString()} ${props.index()!.kinds.length === 1 ? 'type' : 'types'}`}
                      >
                        {notes().toLocaleString()}
                      </span>
                    )}
                  </Show>
                </h2>
                {/* Kinds re-arrive as fresh objects after each change; keep rows mounted by position. */}
                <For each={shelves}>
                  {([shelf, label]) => (
                    <Show when={shelf === 'notes' || props.shelfKinds()[shelf]?.length}>
                      <h3 class="index-shelf">{label}</h3>
                      <Index each={props.shelfKinds()[shelf] ?? []}>{kindRow}</Index>
                      <Show when={shelf === 'notes'}>{fields()}</Show>
                    </Show>
                  )}
                </For>
                <Show when={props.index()?.spreads.length}>
                  <h3 class="index-shelf">Spreads</h3>
                  <For each={props.index()?.spreads}>
                    {spread => (
                      <Button
                        class={`index-kind ${pageIdOf(props.activeEntry()) === spread.id ? 'selected' : ''}`}
                        icon="panes"
                        title={spread.title}
                        onClick={event => onOpen({ kind: 'page', pageId: spread.id }, opensBeside(event))}
                      >
                        <span>{spread.title}</span>
                      </Button>
                    )}
                  </For>
                </Show>
              </section>
            </Show>
            <section class="page-list" aria-label="Saved views">
              <h2>
                <span class="section-number">{props.sectionNumber('views')}</span>Views
                <span class="section-rule" />
                <span class="section-count">{props.looseViews().length || ''}</span>
              </h2>
              <ViewLinks
                views={props.looseViews()}
                pinned={false}
                activeId={props.activeViewId()}
                onOpen={onOpenView}
                onPin={props.onPinView}
              />
              <Button icon="plus" onClick={event => props.onNewView(event.currentTarget, props.owner())}>
                New view…
              </Button>
            </section>
            <details class="page-list" open>
              <summary>
                <span class="section-number">{props.sectionNumber('recent')}</span>Recent
                <span class="section-rule" />
                <Icon name="down" />
              </summary>
              <Show
                when={props.recentRoots().length}
                fallback={<p class="sidebar-empty">Notes you open appear here</p>}
              >
                <PageLinks
                  roots={props.recentRoots()}
                  sourceIcons
                  workshop={props.workshop}
                  activeId={pageIdOf(props.activeEntry())}
                  onOpen={onOpen}
                />
              </Show>
            </details>
          </div>
          <div class="sidebar-foot">
            <WorkshopSwitcher workshop={props.workshop} onOpen={onOpen} onError={props.onError} />
            <Button
              icon="settings"
              label="Settings"
              class={`sidebar-settings ${props.activeEntry()?.target.kind === 'settings' ? 'selected' : ''}`}
              onClick={event => onOpen({ kind: 'settings' }, opensBeside(event))}
            >
              <span>Settings</span>
            </Button>
          </div>
        </>
      }
    >
      <PhoneIndex
        workshop={props.workshop}
        index={props.index()}
        revisits={props.counts()?.revisits ?? 0}
        views={props.views() ?? []}
        pinned={props.pinnedRoots()}
        recent={props.recentRoots()}
        onOpen={onOpen}
        onOpenView={view => onOpenView(view, false)}
        onNewView={anchor => props.onNewView(anchor, props.owner())}
        viewMenu={viewMenuItems}
        questionMenu={() => [{ label: 'Open research desk', icon: 'panes', action: () => onOpen(deskTarget()) }]}
        onError={props.onError}
      />
    </Show>
  );
}
