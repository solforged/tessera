import { For, Show } from 'solid-js';
import type { Block, LibraryRow } from '../api/types';
import { opensBeside } from '../core/beside';
import type { OpenTarget } from '../core/contract';
import { createCollection, deleteCollection, renameCollection } from '../document/collections';
import type { WorkshopClient } from '../document/contract';
import { displayTitle } from '../outline/names';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { CollectionNamePopup, CollectionPicker } from './Collections';
import type { createCollectionActions } from './Collections';
import { SourceCover } from './SourceCover';

export interface CollectionCard {
  page: Block;
  count: number;
  covers: LibraryRow[];
}

export type CollectionPopupState =
  | { kind: 'collection-picker'; anchor: HTMLElement; sources: string[] }
  | { kind: 'collection-name'; anchor: HTMLElement; collection?: Block }
  | { kind: 'delete-collection'; anchor: HTMLElement; collection: Block };

export function CollectionsToolbarHeading(props: {
  collectionsIndex: boolean;
  collectionId: string | null | undefined;
  collection: Block | undefined;
  total: number;
  busy: boolean;
  onNewCollection(anchor: HTMLElement): void;
  onBackToCollections(): void;
  onOpenPage(target: OpenTarget, beside: boolean): void;
  onRenameCollection(anchor: HTMLElement, collection: Block | undefined): void;
  onDeleteCollection(anchor: HTMLElement, collection: Block): void;
}) {
  return (
    <>
      <Show when={props.collectionsIndex}>
        <div class="library-collection-heading">
          <h2>Collections</h2>
          <Button icon="plus" onClick={event => props.onNewCollection(event.currentTarget)}>
            New collection
          </Button>
        </div>
      </Show>
      <Show when={props.collectionId}>
        <div class="library-collection-heading">
          <Button icon="left" onClick={props.onBackToCollections}>
            Collections
          </Button>
          <h2>{props.collection?.text ?? 'Collection'}</h2>
          <span class="library-count">{props.total}</span>
          <Button
            disabled={!props.collection}
            onClick={event => props.onOpenPage({ kind: 'page', pageId: props.collectionId! }, opensBeside(event))}
          >
            Open atom
          </Button>
          <Button
            disabled={!props.collection}
            onClick={event => props.onRenameCollection(event.currentTarget, props.collection)}
          >
            Rename
          </Button>
          <Button
            disabled={!props.collection || props.busy}
            onClick={event => props.onDeleteCollection(event.currentTarget, props.collection!)}
          >
            Delete
          </Button>
        </div>
      </Show>
    </>
  );
}

export function CollectionsView(props: {
  workshop: WorkshopClient;
  slow: boolean;
  loading: boolean;
  collections: Block[] | undefined;
  cards: CollectionCard[] | undefined;
  onSelectCollection(id: string): void;
}) {
  const lookup = (id: string) => props.workshop.lookup(id);
  return (
    <>
      <Show when={props.slow}>
        <p class="library-message" role="status">
          Loading collections…
        </p>
      </Show>
      <Show when={!props.loading && !props.collections?.length}>
        <p class="library-empty">Select books in the library, then choose Add to collection.</p>
      </Show>
      <div class="library-collections" role="list">
        <For each={props.cards}>
          {card => (
            <div role="listitem">
              <Button
                class="library-collection-card"
                data-collection={card.page.id}
                onClick={() => props.onSelectCollection(card.page.id)}
              >
                <span class="library-collection-covers" aria-hidden="true">
                  <For each={card.covers}>
                    {row => <SourceCover api={props.workshop.api} row={row} siglum={row.source.siglum} />}
                  </For>
                  <Show when={!card.covers.length}>
                    <Icon name="shelf" />
                  </Show>
                </span>
                <span class="library-collection-title">{displayTitle(card.page.text, lookup)}</span>
                <span class="library-count">{card.count}</span>
              </Button>
            </div>
          )}
        </For>
      </div>
    </>
  );
}

export function CollectionPopups(props: {
  state: CollectionPopupState;
  workshop: WorkshopClient;
  actions: ReturnType<typeof createCollectionActions>;
  onClearSelection(): void;
  onDeletedCollection(): void;
  onDismiss(): void;
}) {
  if (props.state.kind === 'collection-picker')
    return (
      <CollectionPicker
        anchor={props.state.anchor}
        workshop={props.workshop}
        sourceIds={props.state.sources}
        onChanged={(change, label) => {
          props.actions.record(change, label);
          props.onClearSelection();
        }}
        onDismiss={props.onDismiss}
      />
    );
  if (props.state.kind === 'collection-name') {
    const existing = props.state.collection;
    return (
      <CollectionNamePopup
        anchor={props.state.anchor}
        name={existing?.text}
        onDismiss={props.onDismiss}
        onSave={async name => {
          if (existing)
            props.actions.record(await renameCollection(props.workshop, existing, name), `Renamed to ${name}`);
          else {
            const result = await createCollection(props.workshop, name);
            props.actions.record(result.change, `Created ${name}`);
          }
          props.onDismiss();
        }}
      />
    );
  }
  const target = props.state.collection;
  return (
    <Popup anchor={props.state.anchor} label="Delete collection?" onDismiss={props.onDismiss}>
      <p>Delete “{target.text}”? Books stay in the library.</p>
      <div class="popup-actions">
        <Button disabled={props.actions.busy()} onClick={props.onDismiss}>
          Cancel
        </Button>
        <Button
          class="bordered danger"
          disabled={props.actions.busy()}
          onClick={() => {
            void props.actions
              .run('Deleted collection', () => deleteCollection(props.workshop, target))
              .then(done => {
                if (done) {
                  props.onDeletedCollection();
                  props.onDismiss();
                }
              });
          }}
        >
          Delete collection
        </Button>
      </div>
    </Popup>
  );
}
