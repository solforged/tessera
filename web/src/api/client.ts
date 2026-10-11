import { EMBEDDED } from '../demo/mode';
import type {
  Actor,
  ExtractedMetadata,
  LookupPreview,
  IngestPlan,
  Agenda,
  Backlink,
  BackupInfo,
  CreatedBackup,
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
  HighlightQuery,
  HighlightResult,
  IngestJob,
  LibraryQuery,
  LibraryResult,
  LibraryView,
  PassageHit,
  PassagePage,
  ReadingProgress,
  SourceView,
  Type,
  NoteEntry,
  NoteIndex,
  NoteKind,
  Query,
  QueryResult,
  View,
  NotebookInfo,
  PageView,
  ProjectRecord,
  PositionRow,
  QuestionQuery,
  QuestionRow,
  ReviewEvent,
  ReviewSession,
  ServiceInfo,
  SettingsView,
  TaskOccurrence,
  Surfacing,
  SurfacingAction,
  TaskQuery,
  TaskQueryResult,
  TaskView,
  WorkSession,
} from './types';

export type ExportFormat = 'bibtex' | 'csl' | 'markdown';

export interface AgentChange {
  seq: number;
  actor: Actor;
  reason: string | null;
  created_at: number;
  summary: string;
  page: Block | null;
  undone_by: number | null;
}

export interface UndoReceipt {
  undone: number;
  kept_pages: Block[];
  committed: Committed;
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;
let transport: Transport = (url, init) => fetch(url, init);
export function setTransport(value: Transport): void { transport = value; }

export const CHANGE_CONNECTING = 0;
export const CHANGE_OPEN = 1;
export const CHANGE_CLOSING = 2;
export const CHANGE_CLOSED = 3;
export interface ChangeSocket {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close(): void;
}
type StreamFactory = (after: number) => ChangeSocket;
let streamFactory: StreamFactory | undefined;
export function setStreamFactory(value: StreamFactory): void { streamFactory = value; }
export const exportExtensions: Record<ExportFormat, string> = { bibtex: 'bib', csl: 'json', markdown: 'md' };

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
  const json = frozen ?? (body === undefined ? undefined : JSON.stringify(body));
  return send<T>(`${base}/api${path}`, { method, signal, headers: json === undefined ? undefined : { 'Content-Type': 'application/json' }, body: json });
}

async function send<T>(url: string, init: RequestInit & { signal?: AbortSignal }, decode?: (response: Response) => Promise<T>): Promise<T> {
  let response: Response;
  try {
    response = await transport(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError('The notebook service is not reachable.', 0, 'unreachable');
  }
  if (response.ok && decode) return decode(response);
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
  service(signal?: AbortSignal): Promise<ServiceInfo>;
  backups(signal?: AbortSignal): Promise<BackupInfo[]>;
  createBackup(signal?: AbortSignal): Promise<CreatedBackup>;
  agentChanges(limit?: number, signal?: AbortSignal): Promise<AgentChange[]>;
  undoAgentChange(seq: number, signal?: AbortSignal): Promise<UndoReceipt>;
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
  positions(query: { holder?: string; subject?: string; limit?: number }, signal?: AbortSignal): Promise<PositionRow[]>;
  questions(query: QuestionQuery, signal?: AbortSignal): Promise<QuestionRow[]>;
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
  noteIndex(signal?: AbortSignal): Promise<NoteIndex>;
  kindNotes(key: string, signal?: AbortSignal): Promise<NoteEntry[]>;
  noteKinds(pageId: string, signal?: AbortSignal): Promise<NoteKind[]>;
  query(value: Query, signal?: AbortSignal): Promise<QueryResult>;
  views(signal?: AbortSignal): Promise<View[]>;
  view(id: string, signal?: AbortSignal): Promise<View>;
  complete(q: string, limit?: number, signal?: AbortSignal): Promise<Block[]>;
  search(q: string, limit?: number, signal?: AbortSignal): Promise<BlockInPage[]>;
  changes(after: number, limit?: number, signal?: AbortSignal): Promise<ChangeEvent[]>;
  submit(batch: Batch, signal?: AbortSignal): Promise<Committed>;
  submitFrozen(json: string, signal?: AbortSignal): Promise<Committed>;
  stream(after: number): ChangeSocket;
  library(value: LibraryQuery, signal?: AbortSignal): Promise<LibraryResult>;
  lookup(query: string, signal?: AbortSignal): Promise<LookupPreview>;
  normalizeMetadata(metadata: ExtractedMetadata): Promise<ExtractedMetadata>;
  planRecord(metadata: ExtractedMetadata, coverUrl?: string | null): Promise<IngestPlan>;
  uploadCover(file: Blob): Promise<string>;
  libraryViews(signal?: AbortSignal): Promise<LibraryView[]>;
  ingestJobs(limit?: number, signal?: AbortSignal): Promise<IngestJob[]>;
  queueUrl(url: string, targetSource?: string, signal?: AbortSignal): Promise<IngestJob>;
  upload(file: Blob, name: string, targetSource?: string, signal?: AbortSignal): Promise<IngestJob>;
  retryJob(id: string, signal?: AbortSignal): Promise<IngestJob>;
  source(id: string, signal?: AbortSignal): Promise<SourceView>;
  /** What the current snapshot's metadata renders to, per field name. */
  extracted(id: string, signal?: AbortSignal): Promise<[string, string[]][]>;
  passages(snapshotId: string, from: number, limit?: number, signal?: AbortSignal): Promise<PassagePage>;
  /** The ordinal of a passage locator or anchor, or null. */
  locate(snapshotId: string, at: string, signal?: AbortSignal): Promise<number | null>;
  resourceUrl(snapshotId: string, href: string): string;
  resource(snapshotId: string, href: string, signal?: AbortSignal): Promise<Blob>;
  /** Record the reading position: the first passage on screen. */
  readingPosition(snapshotId: string, ordinal: number, signal?: AbortSignal): Promise<ReadingProgress>;
  searchPassages(q: string, sourceId?: string, limit?: number, signal?: AbortSignal): Promise<PassageHit[]>;
  highlights(value: HighlightQuery, signal?: AbortSignal): Promise<HighlightResult>;
  resurfacing(date: string, limit?: number, signal?: AbortSignal): Promise<Surfacing[]>;
  recordSurfacing(citationId: string, date: string, action: SurfacingAction, signal?: AbortSignal): Promise<void>;
  /** Export all active sources when `ids` is empty. */
  exportSources(format: ExportFormat, ids: readonly string[], signal?: AbortSignal): Promise<Blob>;
  exportQuery(format: ExportFormat, query: LibraryQuery, signal?: AbortSignal): Promise<Blob>;
}

type NativeMethod = 'service' | 'backups' | 'createBackup' | 'queueUrl';

export function createApi(base = ''): ApiClient {
  const get = <T>(path: string, signal?: AbortSignal) => request<T>(base, 'GET', path, undefined, signal);
  const resourceUrl = (snapshotId: string, href: string) => href.startsWith('/api/library/covers/') ? `${base}${href}` : `${base}/api/snapshots/${segment(snapshotId)}/resources/${href.split('/').map(segment).join('/')}`;
  return {
    notebook: (signal?: AbortSignal) => get<NotebookInfo>('/notebook', signal),
    ...(!EMBEDDED ? {
      service: (signal?: AbortSignal) => get<ServiceInfo>('/service', signal),
      backups: (signal?: AbortSignal) => get<BackupInfo[]>('/backups', signal),
      createBackup: (signal?: AbortSignal) => request<CreatedBackup>(base, 'POST', '/backups', undefined, signal),
      queueUrl: (url: string, targetSource?: string, signal?: AbortSignal) => request<IngestJob>(base, 'POST', '/library/jobs', { url, target_source: targetSource ?? null }, signal),
    } : {}),
    agentChanges: (limit = 50, signal?: AbortSignal) => get<AgentChange[]>(`/agent-changes${query({ limit })}`, signal),
    undoAgentChange: (seq: number, signal?: AbortSignal) => request<UndoReceipt>(base, 'POST', `/agent-changes/${seq}/undo`, { actor: { kind: 'person' } }, signal),
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
    positions: (query: { holder?: string; subject?: string; limit?: number }, signal?: AbortSignal) => {
      const params = new URLSearchParams();
      if (query.holder !== undefined) params.set('holder', query.holder);
      if (query.subject !== undefined) params.set('subject', query.subject);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      return get<PositionRow[]>(`/positions?${params}`, signal);
    },
    questions: (query: QuestionQuery, signal?: AbortSignal) => {
      const params = new URLSearchParams();
      if (query.status !== undefined) params.set('status', query.status);
      if (query.review_by !== undefined) params.set('review_by', query.review_by);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      return get<QuestionRow[]>(`/questions?${params}`, signal);
    },
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
    noteIndex: (signal?: AbortSignal) => get<NoteIndex>('/index', signal),
    kindNotes: (key: string, signal?: AbortSignal) => get<NoteEntry[]>(`/index/${segment(key)}`, signal),
    noteKinds: (pageId: string, signal?: AbortSignal) => get<NoteKind[]>(`/pages/${segment(pageId)}/kinds`, signal),
    query: (value: Query, signal?: AbortSignal) => request<QueryResult>(base, 'POST', '/query', value, signal),
    views: (signal?: AbortSignal) => get<View[]>('/views', signal),
    view: (id: string, signal?: AbortSignal) => get<View>(`/views/${segment(id)}`, signal),
    complete: (q: string, limit = 20, signal?: AbortSignal) => get<Block[]>(`/complete${query({ q, limit })}`, signal),
    search: (q: string, limit = 40, signal?: AbortSignal) => get<BlockInPage[]>(`/search${query({ q, limit })}`, signal),
    changes: (after: number, limit = 500, signal?: AbortSignal) => get<ChangeEvent[]>(`/changes${query({ after, limit })}`, signal),
    submit: (batch: Batch, signal?: AbortSignal) => request<Committed>(base, 'POST', '/batches', batch, signal),
    submitFrozen: (json: string, signal?: AbortSignal) => request<Committed>(base, 'POST', '/batches', undefined, signal, json),
    stream: (after: number) => {
      if (streamFactory) return streamFactory(after);
      const url = new URL(`${base}/api/changes/stream${query({ after })}`, typeof location === 'undefined' ? 'http://127.0.0.1' : location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return new WebSocket(url.href);
    },
    library: (value: LibraryQuery, signal?: AbortSignal) => request<LibraryResult>(base, 'POST', '/library/query', value, signal),
    lookup: (query: string, signal?: AbortSignal) => request<LookupPreview>(base, 'POST', '/library/lookup', { query }, signal),
    normalizeMetadata: (metadata: ExtractedMetadata) => request<ExtractedMetadata>(base, 'POST', '/library/metadata', metadata),
    planRecord: (metadata: ExtractedMetadata, cover_url?: string | null) => request<IngestPlan>(base, 'POST', '/library/records/plan', { metadata, cover_url }),
    uploadCover: (file: Blob) => send<string>(`${base}/api/library/covers`, { method: 'POST', body: file, headers: { 'Content-Type': file.type } }),
    libraryViews: (signal?: AbortSignal) => get<LibraryView[]>('/library/views', signal),
    ingestJobs: (limit = 50, signal?: AbortSignal) => get<IngestJob[]>(`/library/jobs${query({ limit })}`, signal),
    upload: (file: Blob, name: string, targetSource?: string, signal?: AbortSignal) => send<IngestJob>(`${base}/api/library/uploads${query({ target_source: targetSource })}`, {
      method: 'POST', signal, body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
    }),
    retryJob: (id: string, signal?: AbortSignal) => request<IngestJob>(base, 'POST', `/library/jobs/${segment(id)}/retry`, undefined, signal),
    source: (id: string, signal?: AbortSignal) => get<SourceView>(`/sources/${segment(id)}`, signal),
    extracted: (id: string, signal?: AbortSignal) => get<[string, string[]][]>(`/sources/${segment(id)}/extracted`, signal),
    passages: (snapshotId: string, from: number, limit = 200, signal?: AbortSignal) => get<PassagePage>(`/snapshots/${segment(snapshotId)}/passages${query({ from, limit })}`, signal),
    locate: (snapshotId: string, at: string, signal?: AbortSignal) => get<number | null>(`/snapshots/${segment(snapshotId)}/locate${query({ at })}`, signal),
    resourceUrl,
    resource: (snapshotId: string, href: string, signal?: AbortSignal) => send<Blob>(resourceUrl(snapshotId, href), { method: 'GET', signal }, response => response.blob()),
    readingPosition: (snapshotId: string, ordinal: number, signal?: AbortSignal) => request<ReadingProgress>(base, 'POST', `/snapshots/${segment(snapshotId)}/position`, { ordinal }, signal),
    searchPassages: (q: string, sourceId?: string, limit = 40, signal?: AbortSignal) => get<PassageHit[]>(`/passages/search${query({ q, source: sourceId, limit })}`, signal),
    highlights: (value: HighlightQuery, signal?: AbortSignal) => request<HighlightResult>(base, 'POST', '/highlights/query', value, signal),
    resurfacing: (date: string, limit = 3, signal?: AbortSignal) => get<Surfacing[]>(`/highlights/resurface${query({ date, limit })}`, signal),
    recordSurfacing: (citationId: string, date: string, action: SurfacingAction, signal?: AbortSignal) => request<void>(base, 'POST', `/highlights/${segment(citationId)}/resurface`, { date, action }, signal),
    exportSources: (format: ExportFormat, ids: readonly string[], signal?: AbortSignal) => send<Blob>(`${base}/api/library/export${query({ format, ids: ids.length ? ids.join(',') : undefined })}`, { method: 'GET', signal }, response => response.blob()),
    exportQuery: (format: ExportFormat, query: LibraryQuery, signal?: AbortSignal) => send<Blob>(`${base}/api/library/export`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, query }),
    }, response => response.blob()),
    // Only service, backups and article URL ingestion are absent in embedded builds; their callers are guarded.
  } satisfies Omit<ApiClient, NativeMethod> as ApiClient;
}

export const api = createApi();

