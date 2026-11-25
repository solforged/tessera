import { batch, createMemo, createSignal, onCleanup } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { ulid } from 'ulid';
import type { Operation, Topic } from '../api/types';
import { createTopicQuery, type TopicQuerySource } from '../ui/loading';

export interface SavedViewRecord<TQuery> {
  id: string;
  name: string;
  revision: number;
  query: TQuery;
}

export interface SavedViewWorkshop extends TopicQuerySource {
  commit(operations: Operation[], reason?: string): Promise<unknown>;
}

export interface SavedViewControllerOptions<TView extends SavedViewRecord<TQuery>, TQuery> {
  workshop: SavedViewWorkshop;
  topic: Topic;
  viewId?: Accessor<string | null | undefined>;
  list: (signal: AbortSignal) => Promise<TView[]>;
  get?: (id: string, signal: AbortSignal) => Promise<TView>;
  saveOperation: (params: { id: string; baseRevision: number | null; name: string; query: TQuery }) => Operation;
  deleteOperation: (params: { id: string; baseRevision: number }) => Operation;
  initialViews?: TView[];
  deleteUndoMs?: number;
  onViewsLoaded?: (views: TView[]) => void;
  onSavedLoaded?: (view: TView) => void;
  onError?: (message: string) => void;
}

export interface SavedViewController<TView extends SavedViewRecord<TQuery>, TQuery> {
  views: Accessor<TView[]>;
  viewsLoading: Accessor<boolean>;
  viewsError: Accessor<string>;
  refetchViews: () => void;
  saved: Accessor<TView | undefined>;
  setSaved: Setter<TView | undefined>;
  savedLoading: Accessor<boolean>;
  savedError: Accessor<string>;
  refetchSaved: () => void;
  deleted: Accessor<TView | null>;
  clearDeleted: () => void;
  saving: Accessor<boolean>;
  deleting: Accessor<boolean>;
  busy: Accessor<boolean>;
  error: Accessor<string>;
  setError: Setter<string>;
  save: (params: {
    id?: string;
    name: string;
    query: TQuery;
    baseRevision?: number | null;
    reason?: string;
  }) => Promise<string>;
  remove: (view: TView, reason?: string) => Promise<boolean>;
  undoDelete: (reason?: string) => Promise<TView | null>;
}

const DEFAULT_DELETE_UNDO_MS = 10_000;

/**
 * Shared saved-view state, topic-keyed list/detail queries, CRUD mutations and 10-second delete-undo retention
 * across Table, Library, Agenda, Index and Desk panes.
 */
export function createSavedViewController<TView extends SavedViewRecord<TQuery>, TQuery>(
  options: SavedViewControllerOptions<TView, TQuery>,
): SavedViewController<TView, TQuery> {
  const [deleted, setDeleted] = createSignal<TView | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [error, setError] = createSignal('');
  let deletedTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  onCleanup(() => {
    disposed = true;
    clearTimeout(deletedTimer);
  });

  const reportError = (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (!disposed) {
      setError(message);
      options.onError?.(message);
    }
    return message;
  };

  const viewsQuery = createTopicQuery<true, TView[]>({
    workshop: options.workshop,
    topics: [options.topic],
    key: () => true,
    fetcher: (_, signal) => options.list(signal),
    initial: options.initialViews ?? [],
    onSuccess: result => options.onViewsLoaded?.(result),
    onError: message => options.onError?.(message),
  });

  const activeId = createMemo(() => {
    const id = options.viewId?.() ?? null;
    if (!id || deleting() || deleted()?.id === id) return null;
    return id;
  });

  const savedQuery = createTopicQuery<string, TView>({
    workshop: options.workshop,
    topics: [options.topic],
    key: () => (options.get ? activeId() : null),
    fetcher: (id, signal) => options.get!(id, signal),
    onSuccess: value => options.onSavedLoaded?.(value),
    onError: message => options.onError?.(message),
  });

  const saved = createMemo<TView | undefined>(() => {
    if (options.get) return savedQuery.data();
    const id = activeId();
    return id ? viewsQuery.data()?.find(item => item.id === id) : undefined;
  });

  const clearDeleted = () => {
    clearTimeout(deletedTimer);
    setDeleted(null);
  };

  const save: SavedViewController<TView, TQuery>['save'] = async params => {
    const id = params.id ?? ulid();
    setSaving(true);
    setError('');
    try {
      await options.workshop.commit(
        [
          options.saveOperation({
            id,
            baseRevision: params.baseRevision ?? null,
            name: params.name.trim(),
            query: params.query,
          }),
        ],
        params.reason,
      );
      if (!disposed) {
        viewsQuery.refresh();
        savedQuery.refresh();
      }
      return id;
    } catch (reason) {
      reportError(reason);
      throw reason;
    } finally {
      if (!disposed) setSaving(false);
    }
  };

  const remove: SavedViewController<TView, TQuery>['remove'] = async (view, reason) => {
    if (deleting()) return false;
    setDeleting(true);
    setError('');
    try {
      await options.workshop.commit([options.deleteOperation({ id: view.id, baseRevision: view.revision })], reason);
      if (!disposed) {
        clearTimeout(deletedTimer);
        deletedTimer = setTimeout(() => setDeleted(null), options.deleteUndoMs ?? DEFAULT_DELETE_UNDO_MS);
        batch(() => {
          setDeleted(() => view);
          savedQuery.mutate(undefined);
          viewsQuery.refresh();
        });
      }
      return true;
    } catch (err) {
      reportError(err);
      return false;
    } finally {
      if (!disposed) setDeleting(false);
    }
  };

  const undoDelete: SavedViewController<TView, TQuery>['undoDelete'] = async reason => {
    const value = deleted();
    if (!value || saving() || deleting()) return null;
    setSaving(true);
    setError('');
    try {
      await options.workshop.commit(
        [
          options.saveOperation({
            id: value.id,
            baseRevision: null,
            name: value.name,
            query: value.query,
          }),
        ],
        reason,
      );
      if (!disposed) {
        clearDeleted();
        viewsQuery.refresh();
        savedQuery.refresh();
      }
      return value;
    } catch (err) {
      reportError(err);
      return null;
    } finally {
      if (!disposed) setSaving(false);
    }
  };

  return {
    views: () => viewsQuery.data() ?? [],
    viewsLoading: viewsQuery.loading,
    viewsError: viewsQuery.error,
    refetchViews: viewsQuery.refresh,
    saved,
    setSaved: savedQuery.mutate,
    savedLoading: savedQuery.loading,
    savedError: savedQuery.error,
    refetchSaved: savedQuery.refresh,
    deleted,
    clearDeleted,
    saving,
    deleting,
    busy: () => saving() || deleting(),
    error,
    setError,
    save,
    remove,
    undoDelete,
  };
}
