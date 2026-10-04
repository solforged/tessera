import type {
  Agenda,
  Backlink,
  Batch,
  Block,
  BlockCapabilities,
  BlockInPage,
  CardPreviews,
  CardQuery,
  CardQueryResult,
  CardUnit,
  ChangeEvent,
  Committed,
  Deck,
  Fields,
  Type,
  Query,
  QueryResult,
  View,
  NotebookInfo,
  PageView,
  ProjectRecord,
  ReviewEvent,
  ReviewSession,
  SettingsView,
  TaskOccurrence,
  TaskQuery,
  TaskQueryResult,
  TaskView,
  WorkSession,
} from './types';

/** A failed request. `status` is 0 when the service could not be reached. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the request may have reached the service and committed. */
  get uncertain(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
}

async function request<T>(base: string, method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal, frozen?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}/api${path}`, {
      method,
      signal,
      headers: body === undefined && frozen === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: frozen ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('The notebook service is not reachable.', 0, 'unreachable');
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = (parsed as ErrorEnvelope | null)?.error;
    throw new ApiError(
      envelope?.message ?? `Request failed with status ${response.status}.`,
      response.status,
      envelope?.code ?? 'http',
      envelope?.details ?? null,
    );
  }
  return parsed as T;
}

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
};
const segment = encodeURIComponent;

export interface ApiClient {
  notebook(signal?: AbortSignal): Promise<NotebookInfo>;
  settings(signal?: AbortSignal): Promise<SettingsView>;
  roots(signal?: AbortSignal): Promise<Block[]>;
  page(id: string, signal?: AbortSignal): Promise<PageView>;
  pageByTitle(title: string, signal?: AbortSignal): Promise<Block>;
  journal(date: string, signal?: AbortSignal): Promise<Block>;
  block(id: string, signal?: AbortSignal): Promise<Block>;
  capabilities(id: string, signal?: AbortSignal): Promise<BlockCapabilities>;
  taskOccurrences(id: string, signal?: AbortSignal): Promise<TaskOccurrence[]>;
  workSessions(id: string, signal?: AbortSignal): Promise<WorkSession[]>;
  activeWorkSession(signal?: AbortSignal): Promise<WorkSession | null>;
  projects(signal?: AbortSignal): Promise<ProjectRecord[]>;
  taskQuery(value: TaskQuery, signal?: AbortSignal): Promise<TaskQueryResult>;
  agenda(date: string, signal?: AbortSignal): Promise<Agenda>;
  taskViews(signal?: AbortSignal): Promise<TaskView[]>;
  taskView(id: string, signal?: AbortSignal): Promise<TaskView>;
  sourceCards(id: string, signal?: AbortSignal): Promise<CardUnit[]>;
  card(id: string, signal?: AbortSignal): Promise<CardUnit>;
  cardQuery(value: CardQuery, signal?: AbortSignal): Promise<CardQueryResult>;
  cardPreviews(id: string, signal?: AbortSignal): Promise<CardPreviews>;
  cardReviews(id: string, signal?: AbortSignal): Promise<ReviewEvent[]>;
  decks(signal?: AbortSignal): Promise<Deck[]>;
  deck(id: string, signal?: AbortSignal): Promise<Deck>;
  reviewSessions(signal?: AbortSignal): Promise<ReviewSession[]>;
  reviewSession(id: string, signal?: AbortSignal): Promise<ReviewSession>;
  backlinks(id: string, limit?: number, signal?: AbortSignal): Promise<Backlink[]>;
  members(id: string, limit?: number, signal?: AbortSignal): Promise<BlockInPage[]>;
  fields(signal?: AbortSignal): Promise<Fields>;
  type(id: string, signal?: AbortSignal): Promise<Type>;
  query(value: Query, signal?: AbortSignal): Promise<QueryResult>;
  views(signal?: AbortSignal): Promise<View[]>;
  view(id: string, signal?: AbortSignal): Promise<View>;
  complete(q: string, limit?: number, signal?: AbortSignal): Promise<Block[]>;
  search(q: string, limit?: number, signal?: AbortSignal): Promise<BlockInPage[]>;
  changes(after: number, limit?: number, signal?: AbortSignal): Promise<ChangeEvent[]>;
  submit(batch: Batch, signal?: AbortSignal): Promise<Committed>;
  submitFrozen(json: string, signal?: AbortSignal): Promise<Committed>;
  streamUrl(after: number): string;
}

export function createApi(base = ''): ApiClient {
  const get = <T>(path: string, signal?: AbortSignal) => request<T>(base, 'GET', path, undefined, signal);
  return {
    notebook: (signal?: AbortSignal) => get<NotebookInfo>('/notebook', signal),
    settings: (signal?: AbortSignal) => get<SettingsView>('/settings', signal),
    roots: (signal?: AbortSignal) => get<Block[]>('/roots', signal),
    page: (id: string, signal?: AbortSignal) => get<PageView>(`/pages/${segment(id)}`, signal),
    pageByTitle: (title: string, signal?: AbortSignal) => get<Block>(`/pages/by-title/${segment(title)}`, signal),
    journal: (date: string, signal?: AbortSignal) => get<Block>(`/journal/${segment(date)}`, signal),
    block: (id: string, signal?: AbortSignal) => get<Block>(`/blocks/${segment(id)}`, signal),
    capabilities: (id: string, signal?: AbortSignal) => get<BlockCapabilities>(`/blocks/${segment(id)}/capabilities`, signal),
    taskOccurrences: (id: string, signal?: AbortSignal) => get<TaskOccurrence[]>(`/blocks/${segment(id)}/task-occurrences`, signal),
    workSessions: (id: string, signal?: AbortSignal) => get<WorkSession[]>(`/blocks/${segment(id)}/work-sessions`, signal),
    activeWorkSession: (signal?: AbortSignal) => get<WorkSession | null>('/work-sessions/active', signal),
    projects: (signal?: AbortSignal) => get<ProjectRecord[]>('/projects', signal),
    taskQuery: (value: TaskQuery, signal?: AbortSignal) => request<TaskQueryResult>(base, 'POST', '/tasks/query', value, signal),
    agenda: (date: string, signal?: AbortSignal) => get<Agenda>(`/agenda/${segment(date)}`, signal),
    taskViews: (signal?: AbortSignal) => get<TaskView[]>('/task-views', signal),
    taskView: (id: string, signal?: AbortSignal) => get<TaskView>(`/task-views/${segment(id)}`, signal),
    sourceCards: (id: string, signal?: AbortSignal) => get<CardUnit[]>(`/blocks/${segment(id)}/cards`, signal),
    card: (id: string, signal?: AbortSignal) => get<CardUnit>(`/cards/${segment(id)}`, signal),
    cardQuery: (value: CardQuery, signal?: AbortSignal) => request<CardQueryResult>(base, 'POST', '/cards/query', value, signal),
    cardPreviews: (id: string, signal?: AbortSignal) => get<CardPreviews>(`/cards/${segment(id)}/previews`, signal),
    cardReviews: (id: string, signal?: AbortSignal) => get<ReviewEvent[]>(`/cards/${segment(id)}/reviews`, signal),
    decks: (signal?: AbortSignal) => get<Deck[]>('/decks', signal),
    deck: (id: string, signal?: AbortSignal) => get<Deck>(`/decks/${segment(id)}`, signal),
    reviewSessions: (signal?: AbortSignal) => get<ReviewSession[]>('/review-sessions', signal),
    reviewSession: (id: string, signal?: AbortSignal) => get<ReviewSession>(`/review-sessions/${segment(id)}`, signal),
    backlinks: (id: string, limit = 100, signal?: AbortSignal) => get<Backlink[]>(`/blocks/${segment(id)}/backlinks${query({ limit })}`, signal),
    members: (id: string, limit = 100, signal?: AbortSignal) => get<BlockInPage[]>(`/types/${segment(id)}/members${query({ limit })}`, signal),
    fields: (signal?: AbortSignal) => get<Fields>('/fields', signal),
    type: (id: string, signal?: AbortSignal) => get<Type>(`/types/${segment(id)}`, signal),
    query: (value: Query, signal?: AbortSignal) => request<QueryResult>(base, 'POST', '/query', value, signal),
    views: (signal?: AbortSignal) => get<View[]>('/views', signal),
    view: (id: string, signal?: AbortSignal) => get<View>(`/views/${segment(id)}`, signal),
    complete: (q: string, limit = 20, signal?: AbortSignal) => get<Block[]>(`/complete${query({ q, limit })}`, signal),
    search: (q: string, limit = 40, signal?: AbortSignal) => get<BlockInPage[]>(`/search${query({ q, limit })}`, signal),
    changes: (after: number, limit = 500, signal?: AbortSignal) => get<ChangeEvent[]>(`/changes${query({ after, limit })}`, signal),
    submit: (batch: Batch, signal?: AbortSignal) => request<Committed>(base, 'POST', '/batches', batch, signal),
    submitFrozen: (json: string, signal?: AbortSignal) => request<Committed>(base, 'POST', '/batches', undefined, signal, json),
    streamUrl: (after: number) => {
      const url = new URL(`${base}/api/changes/stream${query({ after })}`, typeof location === 'undefined' ? 'http://127.0.0.1' : location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.href;
    },
  };
}

export const api = createApi();

/** WebSocket URL for change events after `seq`. */
export function changeStreamUrl(after: number): string {
  return api.streamUrl(after);
}
