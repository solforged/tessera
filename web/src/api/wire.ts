// Generated from the Rust wire types by `ts-wire`. Do not edit: change the
// Rust type, then run `ts-wire`.

/**
 * Who committed a batch.
 */
export type Actor =
  | {
    "kind": "person"
  }
  | {
    "kind": "agent",
    name: string,
  }
  | {
    "kind": "client",
    name: string,
  };

export type Agenda = {
  date: string,
  items: Array<AgendaItem>,
};

export type AgendaItem = {
  source: BlockInPage,
  task: TaskState,
  reasons: Array<AgendaReason>,
  time: string | null,
  project_id: string | null,
  /**
   * Total of this task's stopped, unreversed work sessions, in milliseconds.
   */
  logged_work_ms?: number,
};

export type AgendaReason =
  | "scheduled"
  | "deadline"
  | "warning"
  | "overdue"
  | "unplanned"
  | "in_progress"
  | "recently_completed";

export type AgentProviders = {
  providers: Array<ProviderView>,
  default: string | null,
};

export type AgentTurnEvents = {
  events: Array<TurnEvent>,
  done: boolean,
};

export type AgentTurnStarted = {
  turn: string,
};

export type AssessmentInfo = {
  state: AssessmentState,
  question_id: string | null,
  accepted: boolean,
};

export type AssessmentState = {
  assessed_on: string,
  aporia: boolean,
};

export type Backlink = {
  source: Block,
  page: Block,
};

export type BackupFailure = {
  at: number,
  message: string,
};

export type BackupInfo = {
  path: string,
  name: string,
  created_at: number,
  object_count: number,
  size: number,
  /**
   * What an update or restore safety backup was taken before.
   */
  safety: Safety | null,
};

export type Backups = {
  backups: Array<BackupInfo>,
  store_size: number,
  others: Array<OtherBackups>,
  /**
   * The latest automatic backup's failure, until a later backup succeeds.
   */
  automatic_failure: BackupFailure | null,
};

/**
 * Operations committed together or not at all.
 */
export type Batch = {
  actor: Actor,
  reason?: string | null,
  /**
   * Retrying a batch with the same key and the same operations returns
   * the original result without applying it again. The same key with
   * different operations is rejected.
   */
  idempotency_key?: string | null,
  operations: Array<Operation>,
};

export type BatchSubtree = {
  id: string,
  page: Block | null,
  rows: Array<Row>,
  truncated: boolean,
};

export type BatchSubtrees = {
  trees: Array<BatchSubtree>,
  truncated: boolean,
};

/**
 * One live block as stored. A root's text is its title; a journal root's
 * text is its date in `YYYY-MM-DD` form.
 */
export type Block = {
  id: string,
  kind: BlockKind,
  parent_id: string | null,
  page_id: string,
  text: string,
  /**
   * Heading level 1 to 3.
   */
  heading: 1 | 2 | 3 | null,
  archived: boolean,
  revision: number,
  created_at: number,
  updated_at: number,
  kept_copy?: KeptCopy | null,
};

export type BlockCapabilities = {
  block_id: string,
  built_in_tag: boolean,
  task: TaskState | null,
  project: ProjectState | null,
  note?: NoteState | null,
  note_changed?: boolean,
  position: PositionInfo | null,
  spread?: boolean,
  question: QuestionInfo | null,
  assessment: AssessmentInfo | null,
  relation: RelationInfo | null,
  quote?: QuoteState | null,
  image?: ImageRef | null,
  occlusion?: Occlusion | null,
  source?: SourceRecord | null,
  citations?: Array<Citation>,
  /**
   * Non-reversed task occurrences or work sessions exist for this source.
   */
  history: boolean,
  /**
   * Milliseconds in ended, non-reversed work sessions, excluding running work.
   */
  logged_work_ms: number,
  /**
   * Live capability state, history, or reviewed cards.
   */
  merge_protected: boolean,
  reviewed_cards: boolean,
  template_cards?: number,
};

export type BlockInPage = {
  block: Block,
  page: Block,
};

/**
 * What a block is. Pages and journal days are roots; everything else has a
 * parent.
 */
export type BlockKind = "block" | "page" | "journal";

export type CardAnswerBlock = {
  id: string,
  text: string,
  image?: ImageRef | null,
  children: Array<CardAnswerBlock>,
};

export type CardKind =
  | "forward"
  | "reverse"
  | "cloze"
  | "multiline"
  | "list"
  | "descriptor"
  | "occlusion";

export type CardPreviews = {
  current: Array<GradePreview>,
  reset: Array<GradePreview>,
};

export type CardQuery = {
  source: Query | null,
  selection: CardSelection,
  limit: number | null,
};

export type CardQueryResult = {
  rows: Array<CardRow>,
  total: number,
};

export type CardRow = {
  card: CardUnit,
  source: BlockInPage,
  last_review: ReviewEvent | null,
};

export type CardSelection = "due" | "new" | "all";

export type CardTemplate = {
  id: string,
  type_id: string,
  name: string,
  front: string,
  back: string,
  hint?: string | null,
  details?: Array<string>,
  position: number,
  applied: boolean,
  new_per_day: number,
  revision: number,
  created_at: number,
  updated_at: number,
};

export type CardTemplateForecast = {
  members: number,
  ready: number,
  waiting_total: number,
  waiting: Array<CardTemplateWaiting>,
  existing_units: number,
  cards_to_create: number,
  new_per_day: number,
  days_to_introduce: number,
  last_day: string | null,
  load: Array<TemplateLoadDay>,
};

export type CardTemplateInfo = {
  front_display: string,
  back_display: string,
  ready: number,
  waiting_total: number,
  units_active: number,
  missing: Array<string>,
  preview: CardTemplatePreview | null,
  id: string,
  type_id: string,
  name: string,
  front: string,
  back: string,
  hint?: string | null,
  details?: Array<string>,
  position: number,
  applied: boolean,
  new_per_day: number,
  revision: number,
  created_at: number,
  updated_at: number,
};

export type CardTemplatePreview = {
  member_id: string,
  member_text: string,
  front: string,
  back: string,
};

export type CardTemplateProvenance = {
  id: string,
  name: string,
  type_id: string,
  type_name: string,
  front_label: string,
  back_label: string,
  hint: RecipeDetail | null,
  details: Array<RecipeDetail>,
};

export type CardTemplateWaiting = {
  id: string,
  text: string,
  missing: Array<string>,
};

export type CardUnit = {
  id: string,
  source_block_id: string,
  key: string,
  kind: CardKind,
  active: boolean,
  held: boolean,
  definition_revision: number,
  front: string,
  back: string,
  answer_blocks: Array<CardAnswerBlock>,
  revision: number,
  schedule: SchedulingState,
  template: CardTemplateProvenance | null,
  occlusion_index?: number,
};

/**
 * One committed batch, for clients catching up after `seq`.
 */
export type ChangeEvent = {
  seq: number,
  actor: Actor,
  reason: string | null,
  created_at: number,
  /**
   * Current live state, not a historical snapshot.
   */
  blocks: Array<Block>,
  /**
   * Touched IDs that are no longer live.
   */
  removed: Array<string>,
  /**
   * Pages whose order or nesting changed, recorded when the batch applied.
   */
  restructured_pages: Array<string>,
  /**
   * The receipt's `pages`: every page this change touched. `None` for
   * changes recorded before it was.
   */
  pages?: Array<string>,
  /**
   * Views saved or deleted by this change; clients reload their view list.
   */
  views?: Array<string>,
  /**
   * Settings changed by this batch; clients reload their settings.
   */
  settings?: Array<string>,
  capabilities?: Array<BlockCapabilities>,
  cards?: Array<string>,
  work_sessions?: Array<string>,
  review_sessions?: Array<string>,
  decks?: Array<string>,
  task_views?: Array<string>,
  library_views?: Array<string>,
  /**
   * The receipt's `topics`; `None` means any workshop-wide data may have
   * changed.
   */
  topics?: Array<Topic>,
};

export type Citation = {
  id: string,
  block_id: string,
  source_id: string,
  snapshot_id: string,
  start: PassagePoint,
  end: PassagePoint,
  quote: string,
  locator: string,
  /**
   * Reading-order position of the start passage in its snapshot.
   */
  ordinal: number,
  /**
   * UTF-16 offset of the citation's start in its snapshot's whole text, the unit of `text_length` and passage starts.
   * Reads always fill it; change records stored before it existed lack it, so it stays optional there.
   */
  position?: number,
  chapter_title?: string | null,
  triage: "processed" | "unprocessed" | null,
  color: "yellow" | "green" | "blue" | "red" | "purple" | null,
};

/**
 * The result of a committed batch.
 */
export type Committed = {
  /**
   * Position in the workshop's change sequence.
   */
  seq: number,
  /**
   * The resulting revision of every block the batch changed, in first-
   * touched order.
   */
  revisions: Array<Revision>,
  /**
   * Touched blocks that are no longer live after the batch, including
   * provisional pages removed by derivation.
   */
  removed?: Array<string>,
  /**
   * Exact restoration tickets for unused provisional pages pruned by this batch.
   */
  pruned_pages?: Array<PrunedPage>,
  /**
   * Deletion events created by `Delete` and `Merge`, in operation order.
   */
  deletions: Array<string>,
  /**
   * Pages holding a block the batch changed or removed, plus pages whose
   * order or nesting it changed, sorted. A window learns from its own
   * receipt which pages it touched without fetching each block. `None`
   * in receipts stored before it was recorded.
   */
  pages?: Array<string>,
  /**
   * Pages where the engine placed a block somewhere other than the request
   * named, because its `after` sibling had been moved or deleted, sorted.
   * The sender reloads these pages to learn the order.
   */
  reanchored_pages?: Array<string>,
  /**
   * Text normalized by the engine or changed by tag removal/merge operations.
   * The client applies these rewrites to its editor and undo history.
   * Older persisted receipts predate tag rewriting.
   */
  text_rewrites: Array<TextRewrite>,
  /**
   * Resulting revisions of settings, which are not blocks.
   */
  settings: Array<SettingRevision>,
  capabilities?: Array<BlockCapabilities>,
  cards?: Array<Revision>,
  work_sessions?: Array<WorkSession>,
  review_sessions?: Array<ReviewSession>,
  decks?: Array<Revision>,
  task_views?: Array<Revision>,
  library_views?: Array<Revision>,
  /**
   * Workshop-wide data the batch changed. `None` where a commit did not
   * record them: receipts stored before they were, synced changes and
   * the browser build. A client then assumes any of it may have changed.
   */
  topics?: Array<Topic>,
  /**
   * True when this is the stored result of an earlier identical batch.
   */
  replayed: boolean,
};

export type Completion = {
  alias: string | null,
  id: string,
  kind: BlockKind,
  parent_id: string | null,
  page_id: string,
  text: string,
  /**
   * Heading level 1 to 3.
   */
  heading: 1 | 2 | 3 | null,
  archived: boolean,
  revision: number,
  created_at: number,
  updated_at: number,
  kept_copy?: KeptCopy | null,
};

/**
 * `error.details` of a 409 response.
 */
export type ConflictDetails = {
  op_index: number,
  id: string,
  expected: number,
  found: number | null,
};

export type ContextRef = {
  page_id: string,
  block_id?: string | null,
};

/**
 * What a field's values count as, so readers find creators by meaning rather than by field name.
 */
export type CountsAs = "creator" | "contributor" | "originator";

export type CreatedBackup = {
  created: boolean,
  backups: Backups,
};

export type CreatorKind = "person" | "organisation";

export type CreatorRole = "author" | "editor" | "translator";

export type CrossReference = {
  alias: string,
  targets: Array<SeeTarget>,
};

export type CurrentReading = {
  id: string,
  assessed_on: string,
  text: string,
};

export type DateRange = {
  from: string | null,
  through: string | null,
};

export type DecadeFacet = {
  decade: number,
  count: number,
};

export type Deck = {
  id: string,
  name: string,
  query: CardQuery,
  revision: number,
  created_at: number,
  updated_at: number,
};

/**
 * A recoverable root deletion and its exact restore ticket. Merge tombstones
 * are intentionally absent: a permanent merge cannot be undone by restoration.
 */
export type DeletedPage = {
  block: Block,
  deletion_id: string,
  deleted_at: number,
};

export type DeskQuery = {
  positions: Query,
  sources: Query,
};

export type Direction = "asc" | "desc";

export type ExtractedCreator = {
  /**
   * As written by the publisher, such as `Ursula K. Le Guin` or
   * `Le Guin, Ursula K.`.
   */
  name: string,
  role: CreatorRole,
  kind?: CreatorKind,
  /**
   * False keeps this creator as an ordered plain name, without an entity page.
   */
  create_page?: boolean,
};

export type ExtractedMetadata = {
  title: string | null,
  subtitle: string | null,
  creators: Array<ExtractedCreator>,
  /**
   * `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
   */
  published: string | null,
  publisher: string | null,
  /**
   * BCP 47, such as `en` or `grc`.
   */
  language: string | null,
  /**
   * Raw identifier strings as found, such as `urn:isbn:9780262033848`,
   * `doi:10.1145/3065386` or a bare ISBN. Unrecognized schemes are kept.
   */
  identifiers: Array<string>,
  /**
   * The EPUB package's unique identifier, used to recognise a re-import
   * of the same book with different bytes.
   */
  unique_id: string | null,
  /**
   * Canonical address of an article.
   */
  url: string | null,
  /**
   * Site or publication name of an article.
   */
  site: string | null,
  /**
   * Journal volume and issue, kept as written (not necessarily numbers).
   */
  volume?: string | null,
  issue?: string | null,
  /**
   * Journal page range or article locator, distinct from a total page count.
   */
  page_range?: string | null,
  /**
   * Plain-text description or abstract.
   */
  description: string | null,
  /**
   * `href` of the cover image among the resources.
   */
  cover: string | null,
};

export type FieldChoiceCandidate = {
  text: string,
  option_id: string | null,
  values: Array<FieldChoiceValue>,
};

export type FieldChoiceValue = {
  id: string,
  text: string,
  revision: number,
  page_id: string,
};

export type FieldDefinition = {
  id: string,
  name: string,
  kind: FieldKind,
  hide?: FieldHide,
  role?: FieldRole,
  counts_as?: CountsAs | null,
  archived?: boolean,
  revision: number,
  options: Array<FieldOption>,
  targets: Array<string>,
  /**
   * Created by the app and named by it: the name cannot change except in case.
   */
  built_in?: boolean,
};

export type FieldDetail = {
  field: FieldSummary,
  kind: FieldKind,
  owners_total: number,
  values_total: number,
  empty_total: number,
  problems_total: number,
  templates: Array<FieldTemplate>,
  option_uses: Array<FieldOptionUse>,
  owners: Array<FieldOwnerValues>,
  problems: Array<FieldValueUse>,
  readable: Array<FieldValueUse>,
  /**
   * Complete conversion candidates, not limited by the displayed samples.
   */
  choice_candidates: Array<FieldChoiceCandidate>,
  /**
   * Every distinct written value, for reviewed interpretation across all owners.
   */
  interpretations: Array<FieldInterpretation>,
  /**
   * All entry identities, including empty entries, for lossless schema changes.
   */
  entries: Array<string>,
};

export type FieldHide = "never" | "when_empty" | "always";

export type FieldInterpretation = {
  text: string,
  reading: Reading,
  values: Array<FieldChoiceValue>,
};

export type FieldKind =
  | "text"
  | "number"
  | "date"
  | "span"
  | "checkbox"
  | "choice"
  | "instance"
  | "url"
  | "identifier";

export type FieldOption = {
  id: string,
  text: string,
};

export type FieldOptionUse = {
  option_id: string,
  uses: number,
};

export type FieldOwner = {
  id: string,
  text: string,
  page_id: string,
  page_title: string,
};

export type FieldOwnerValues = {
  owner: FieldOwner,
  /**
   * The first entry in outline order when this owner has several entries.
   */
  entry_id: string,
  values: Array<FieldValue>,
};

export type FieldRole = "standfirst" | "attribute" | "prose" | "citation";

export type FieldSummary = {
  owners: number,
  types: Array<FieldType>,
  id: string,
  name: string,
  kind: FieldKind,
  hide?: FieldHide,
  role?: FieldRole,
  counts_as?: CountsAs | null,
  archived?: boolean,
  revision: number,
  options: Array<FieldOption>,
  targets: Array<string>,
  /**
   * Created by the app and named by it: the name cannot change except in case.
   */
  built_in?: boolean,
};

export type FieldTemplate = {
  type_id: string,
  name: string,
  position: number,
  members: number,
};

export type FieldType = {
  id: string,
  name: string,
};

export type FieldValue = {
  id: string,
  text: string,
  reading: Reading,
};

export type FieldValueUse = {
  owner: FieldOwner,
  entry_id: string,
  value: FieldValue,
};

export type Fields = {
  page_id: string,
  fields: Array<FieldSummary>,
};

export type Filter = {
  field: string,
  op: FilterOp,
  value: string | null,
  or_empty?: boolean,
};

export type FilterOp =
  | "is"
  | "is_not"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "overlaps"
  | "before"
  | "after"
  | "present"
  | "set"
  | "empty";

export type Grade = "again" | "hard" | "good" | "easy";

export type GradePreview = {
  grade: Grade,
  interval_days: number,
};

export type HighlightQuery = {
  source_id?: string | null,
  unprocessed?: boolean,
  colors?: Array<string>,
  tags?: Array<string>,
  limit?: number | null,
};

export type HighlightResult = {
  rows: Array<HighlightRow>,
  total: number,
};

export type HighlightRow = {
  block: BlockInPage,
  citation: Citation,
  source_title: string,
  processed: boolean,
  notes: number,
  triage: Citation["triage"],
  color: Citation["color"],
  tags: Array<string>,
  created_at: number,
};

/**
 * One committed change, newest first in history listings.
 */
export type HistoryEntry = {
  seq: number,
  change_id: string | null,
  origin: string | null,
  actor: Actor,
  reason: string | null,
  created_at: number,
  summary: string,
  /**
   * The live page the change landed on, when it has a single page.
   */
  page: Block | null,
  undoable: boolean,
  undone_by: number | null,
  /**
   * The change this entry undid.
   */
  undoes: number | null,
};

export type HistoryResponse = {
  entries: Array<HistoryEntry>,
};

export type HubPairing = {
  key: string,
  device: PairedDeviceIdentity,
  hub: PairedHub,
};

export type ImageRef = {
  sha256: string,
  media_type: string,
  width: number,
  height: number,
};

/**
 * A relation field value pointing at a block, read from the target's side.
 */
export type IncomingFieldValue = {
  field_id: string,
  field_name: string,
  counts_as?: CountsAs | null,
  owner: FieldOwner,
  value_id: string,
};

export type IndexKind = {
  /**
   * Distinct titled notes, or every visible active atom for a capability kind.
   */
  count: number,
  tagged_block_count: number,
  /**
   * Live cards on members, which is the kind's tag deck.
   */
  cards: number,
  /**
   * The type page's template, as field definition IDs; empty without a type page.
   */
  fields: Array<string>,
  /**
   * Whether `#name` names this kind: built-in type kinds and types you made, not capabilities or Unfiled.
   */
  tag: boolean,
  shelf: Shelf,
  key: string,
  name: string,
  plural: string,
  icon: string | null,
  /**
   * The live page named by this tag; Unfiled has none.
   */
  type_id: string | null,
};

export type IngestInput = "url" | "file";

export type IngestJob = {
  id: string,
  input_kind: IngestInput,
  input: string,
  name: string,
  target_source: string | null,
  state: IngestJobState,
  attempts: number,
  error: string | null,
  next_attempt_at: number | null,
  source_id: string | null,
  snapshot_id: string | null,
  created_at: number,
  updated_at: number,
};

export type IngestJobState = "queued" | "running" | "failed" | "done";

export type IngestPlan = {
  source_id: string,
  created: boolean,
  unchanged: boolean,
  operations: Array<Operation>,
};

/**
 * A live, unsettled version kept beside its original by sync.
 */
export type KeptCopy = {
  of: string,
  origin: string,
  origin_name: string | null,
  mine: boolean,
};

export type KeptCopyRow = {
  id: string,
  of: string,
  page_id: string,
  page_title: string,
  text: string,
  origin: string,
  origin_name: string | null,
  mine: boolean,
  created_at: number,
};

export type KindIndex = {
  notes: Array<NoteEntry>,
  see: Array<CrossReference>,
  /**
   * Batched, derived apparatus for the notes in this read. Nothing is stored.
   */
  summaries: {
    [key in string]: NoteSummary
  },
};

/**
 * A workshop the switcher knows. `display_path` writes the home folder as `~`; `named` marks one
 * made by name in the workshops folder.
 */
export type KnownWorkshop = {
  path: string,
  name: string,
  display_path: string,
  named: boolean,
  current: boolean,
  default: boolean,
  /**
   * False when the folder no longer holds a workshop database.
   */
  available: boolean,
};

export type KnownWorkshops = {
  notebooks: Array<KnownWorkshop>,
};

export type LastError = {
  code: string,
  message: string,
};

export type LaunchAgentInfo = {
  installed: boolean,
  path: string | null,
};

export type LibraryCounts = {
  inbox: number,
  reading: number,
  finished: number,
  abandoned: number,
};

/**
 * Available values after state, format and text filtering, before facet filters
 * and the display limit. Each source counts once per distinct facet value.
 */
export type LibraryFacets = {
  people: Array<PersonFacet>,
  decades: Array<DecadeFacet>,
  years: Array<YearFacet>,
  publishers: Array<ValueFacet>,
  languages: Array<ValueFacet>,
};

export type LibraryPerson = {
  id: string | null,
  name: string,
  role: CreatorRole,
};

export type LibraryQuery = {
  states?: Array<ReadingState>,
  format?: SourceFormat | null,
  text?: string | null,
  /**
   * A collection page referenced by a source's Collections Instance field.
   */
  collection_id?: string | null,
  /**
   * Person page IDs; matches any author, editor or translator.
   */
  people?: Array<string>,
  /**
   * Exact first Publisher readings.
   */
  publishers?: Array<string>,
  /**
   * Publication years floored to the decade.
   */
  decades?: Array<number>,
  /**
   * Publication years, as the first four digits of the published date.
   */
  years?: Array<number>,
  /**
   * Primary language codes as rows and facets report them, such as `en` for `en-US` or `eng`.
   */
  languages?: Array<string>,
  sort?: LibrarySort,
  direction?: Direction,
  limit?: number | null,
};

export type LibraryResult = {
  rows: Array<LibraryRow>,
  total: number,
  counts: LibraryCounts,
  facets: LibraryFacets,
};

export type LibraryRow = {
  page: Block,
  source: SourceRecord,
  creators: Array<string>,
  /**
   * Authors, then editors, then translators, in each field's value order.
   */
  people: Array<LibraryPerson>,
  publisher: string | null,
  /**
   * The first Language reading's primary code, so regional and three-letter forms browse and group together.
   */
  language: string | null,
  published: string | null,
  site: string | null,
  /**
   * The work's Form reading, such as `paper`.
   */
  form: string | null,
  cover: string | null,
  /**
   * The current snapshot's format, such as `article` for a record with a saved web page, so lists can show the
   * right cover or spine before loading the source.
   */
  snapshot_format: SourceFormat | null,
  progress: number,
  /**
   * Contents entry covering the saved reading position.
   */
  section: string | null,
  highlights: number,
  unprocessed: number,
};

export type LibrarySort = "added" | "title" | "author" | "year" | "last_read" | "progress";

export type LibraryView = {
  id: string,
  name: string,
  query: LibraryQuery,
  revision: number,
  created_at: number,
  updated_at: number,
};

export type LinkPreview = {
  title: string | null,
  site: string | null,
};

export type LookupPreview = {
  metadata: ExtractedMetadata,
  cover_url: string | null,
  provider: string,
};

export type Mark = {
  /**
   * UTF-16 offsets into the passage text, `start < end`.
   */
  start: number,
  end: number,
  kind: MarkKind,
};

export type MarkKind =
  | {
    "kind": "emphasis"
  }
  | {
    "kind": "strong"
  }
  | {
    "kind": "code"
  }
  | {
    "kind": "link",
    href: string,
  }
  | {
    "kind": "internal",
    locator: string,
  }
  | {
    "kind": "note_ref",
    locator: string,
  };

export type MaskShape = "rect" | "ellipse";

export type Mention = {
  block: Block,
  page: Block,
  term: string,
};

export type NameMatch = {
  page: Block,
  alias: string | null,
};

export type NoteEntry = {
  id: string,
  page_id: string,
  title: string,
  sort_as: string | null,
  created_at: number,
};

export type NoteGroup = {
  key: string,
  title: string,
  target: string | null,
  siglum: string | null,
  note_ids: Array<string>,
};

/**
 * The sidebar index: every built-in kind, then other kinds with notes or tagged blocks, in index
 * order, and the distinct note total.
 */
export type NoteIndex = {
  kinds: Array<IndexKind>,
  notes: number,
  fields: number,
  spreads: Array<SeeTarget>,
};

/**
 * One kind a note can be filed under. `key` is `person`, `group`, `concept`, `thesis`, `question`,
 * `source`, `project`, `type:<id>` for a type you made, or `unfiled`.
 */
export type NoteKind = {
  key: string,
  name: string,
  plural: string,
  icon: string | null,
  /**
   * The live page named by this tag; Unfiled has none.
   */
  type_id: string | null,
};

export type NoteLayout = "index" | "table";

export type NoteState = {
  resolved_at: number | null,
  revisit_on: string | null,
  date_set_at: number | null,
};

export type NoteSummary = {
  preview: string | null,
  field: SummaryField | null,
  /**
   * Nonempty visible prose descendants, excluding headings and field subtrees.
   */
  block_count: number,
  /**
   * Nonempty visible descendants; an archived subtree cannot make a queue row With text.
   */
  text_blocks: number,
  /**
   * The first three prose blocks, kept separate from a standfirst preview.
   */
  prose_excerpt: Array<string>,
  /**
   * Distinct visible referring blocks, matching the ordinary backlinks read, not citations.
   */
  backlinks: number,
  referenced_from: Array<SeeTarget>,
  source: SourceSummary | null,
};

export type NoteView = {
  layout: NoteLayout,
  /**
   * `letter`, `source`, `link`, `created`, or `field:<definition id>`.
   */
  grouping: string,
};

export type Occlusion = {
  mode: OcclusionMode,
  groups: Array<OcclusionGroup>,
  masks: Array<OcclusionMask>,
};

export type OcclusionGroup = {
  id: string,
  hint?: string,
  answer?: string,
  area?: Rect,
};

export type OcclusionMask = {
  id: string,
  group: string,
  shape: MaskShape,
  x: number,
  y: number,
  w: number,
  h: number,
};

export type OcclusionMode = "hide_one" | "hide_all";

export type OfflineFiles = {
  books: number,
  bytes: number,
};

export type OpeningWorkshop = {
  path: string,
};

/**
 * One outline operation. IDs of new blocks are chosen by the client (ULIDs),
 * so a retried creation can be recognised instead of duplicated. Every
 * operation on an existing block names the revision it was based on; a
 * mismatch fails the whole batch and writes nothing.
 */
export type Operation =
  | {
    "op": "settle_sync_copy",
    id: string,
    settled: boolean,
  }
  | {
    "op": "settle_sync_rejection",
    id: string,
    settled: boolean,
  }
  | {
    "op": "set_source",
    id: string,
    base_revision: number,
    source: SourceState | null,
  }
  | {
    "op": "attach_snapshot",
    id: string,
    base_revision: number,
    snapshot_id: string,
  }
  | {
    "op": "cite",
    id: string,
    base_revision: number,
    citation_id: string,
    snapshot_id: string,
    start: PassagePoint,
    end: PassagePoint,
    color?: Citation["color"],
  }
  | {
    "op": "uncite",
    id: string,
    base_revision: number,
    citation_id: string,
  }
  | {
    "op": "set_citation_triage",
    id: string,
    base_revision: number,
    triage: Citation["triage"],
  }
  | {
    "op": "set_citation_color",
    id: string,
    base_revision: number,
    color: Citation["color"],
  }
  | {
    "op": "set_citation_range",
    id: string,
    base_revision: number,
    start: PassagePoint,
    end: PassagePoint,
  }
  | {
    "op": "create_page",
    id: string,
    title: string,
  }
  | {
    "op": "create_journal",
    id: string,
    date: string,
  }
  | {
    "op": "insert",
    id: string,
    parent_id: string,
    after: string | null,
    text: string,
    heading: 1 | 2 | 3 | null,
  }
  | {
    "op": "edit_text",
    id: string,
    base_revision: number,
    text: string,
  }
  | {
    "op": "set_heading",
    id: string,
    base_revision: number,
    heading: 1 | 2 | 3 | null,
  }
  | {
    "op": "create_card_template",
    id: string,
    type_id: string,
    name: string,
    front: string,
    back: string,
    hint?: string | null,
    details?: Array<string>,
    new_per_day: number,
  }
  | {
    "op": "update_card_template",
    id: string,
    base_revision: number,
    name: string,
    front: string,
    back: string,
    hint?: string | null,
    details?: Array<string>,
    new_per_day: number,
  }
  | {
    "op": "set_card_template_applied",
    id: string,
    base_revision: number,
    applied: boolean,
  }
  | {
    "op": "delete_card_template",
    id: string,
    base_revision: number,
  }
  | {
    "op": "transfer_card_key",
    source_id: string,
    key: string,
    to_key: string | null,
    base_revision: number | null,
    held: boolean,
  }
  | {
    "op": "split",
    id: string,
    base_revision: number,
    new_id: string,
    left: string,
    right: string,
  }
  | {
    "op": "merge",
    source_id: string,
    source_revision: number,
    destination_id: string,
    destination_revision: number,
  }
  | {
    "op": "merge_page",
    source_id: string,
    source_revision: number,
    destination_id: string,
    destination_revision: number,
  }
  | {
    "op": "move",
    id: string,
    base_revision: number,
    parent_id: string,
    after: string | null,
  }
  | {
    "op": "delete",
    id: string,
    base_revision: number,
  }
  | {
    "op": "restore",
    id: string,
    deletion_id: string,
    revision: number,
  }
  | {
    "op": "set_archived",
    id: string,
    base_revision: number,
    archived: boolean,
  }
  | {
    "op": "add_type",
    id: string,
    base_revision: number,
    title: string,
  }
  | {
    "op": "remove_type",
    id: string,
    base_revision: number,
    title: string,
  }
  | {
    "op": "set_field_kind",
    id: string,
    base_revision: number,
    kind: FieldKind,
  }
  | {
    "op": "set_field_hide",
    id: string,
    base_revision: number,
    hide: FieldHide,
  }
  | {
    "op": "set_field_role",
    id: string,
    base_revision: number,
    role: FieldRole,
  }
  | {
    "op": "set_field_counts_as",
    id: string,
    base_revision: number,
    counts_as: CountsAs | null,
  }
  | {
    "op": "set_field_targets",
    id: string,
    base_revision: number,
    targets: Array<string>,
  }
  | {
    "op": "set_type_fields",
    type_id: string,
    base_revision: number,
    fields: Array<string>,
  }
  | {
    "op": "set_type_presentation",
    type_id: string,
    base_revision: number,
    plural: string | null,
    icon: string | null,
  }
  | {
    "op": "set_subject_criteria",
    subject_id: string,
    base_revision: number,
    fields: Array<string>,
  }
  | {
    "op": "save_view",
    id: string,
    base_revision: number | null,
    name: string,
    query: Query,
  }
  | {
    "op": "delete_view",
    id: string,
    base_revision: number,
  }
  | {
    "op": "set_setting",
    key: string,
    base_revision: number | null,
    value: string,
  }
  | {
    "op": "set_task",
    id: string,
    base_revision: number,
    task: TaskState | null,
  }
  | {
    "op": "restore_task_state",
    id: string,
    base_revision: number,
    expected: TaskState,
    task: TaskState,
  }
  | {
    "op": "complete_task",
    id: string,
    base_revision: number,
    occurrence_id: string,
    completed_on: string,
  }
  | {
    "op": "reverse_task_completion",
    id: string,
    base_revision: number,
    occurrence_id: string,
  }
  | {
    "op": "set_project",
    id: string,
    base_revision: number,
    project: ProjectState | null,
  }
  | {
    "op": "set_position",
    id: string,
    base_revision: number,
    position: boolean,
  }
  | {
    "op": "set_relation",
    id: string,
    base_revision: number,
    relation: RelationKind | null,
  }
  | {
    "op": "set_spread",
    id: string,
    base_revision: number,
    spread: boolean,
  }
  | {
    "op": "revisit",
    id: string,
    base_revision: number,
    action: RevisitAction,
    next_on: string | null,
    event_id: string | null,
  }
  | {
    "op": "restore_revisit",
    id: string,
    base_revision: number,
    state: RevisitSnapshot,
    event_id: string | null,
  }
  | {
    "op": "set_quote",
    id: string,
    base_revision: number,
    quote: QuoteState | null,
  }
  | {
    "op": "set_image",
    id: string,
    base_revision: number,
    image: ImageRef | null,
  }
  | {
    "op": "set_occlusion",
    id: string,
    base_revision: number,
    occlusion: Occlusion | null,
  }
  | {
    "op": "set_question",
    id: string,
    base_revision: number,
    question: QuestionState | null,
  }
  | {
    "op": "set_assessment",
    id: string,
    base_revision: number,
    assessment: AssessmentState | null,
  }
  | {
    "op": "start_work",
    id: string,
    base_revision: number,
    session_id: string,
    started_at: number,
    note: string,
  }
  | {
    "op": "stop_work",
    id: string,
    base_revision: number,
    session_id: string,
    session_revision: number,
    ended_at: number,
    note: string,
  }
  | {
    "op": "edit_work_note",
    id: string,
    base_revision: number,
    session_id: string,
    session_revision: number,
    note: string,
  }
  | {
    "op": "set_work_session_state",
    id: string,
    base_revision: number,
    session_id: string,
    session_revision: number,
    ended_at: number | null,
    reversed: boolean,
  }
  | {
    "op": "start_review_session",
    id: string,
    deck_id: string | null,
    started_at: number,
  }
  | {
    "op": "finish_review_session",
    id: string,
    base_revision: number,
    state: ReviewSessionState,
    ended_at: number,
  }
  | {
    "op": "grade_card",
    id: string,
    base_revision: number,
    definition_revision: number,
    event_id: string,
    session_id: string | null,
    grade: Grade,
    reset: boolean,
    shown_front: string,
    shown_back: string,
    reviewed_at: number,
  }
  | {
    "op": "undo_grade",
    id: string,
    base_revision: number,
    review_id: string,
    event_id: string,
    session_revision: number | null,
    undone_at: number,
  }
  | {
    "op": "set_card_held",
    id: string,
    base_revision: number,
    held: boolean,
  }
  | {
    "op": "reset_card",
    id: string,
    base_revision: number,
    event_id: string,
    session_id: string | null,
    reviewed_at: number,
  }
  | {
    "op": "save_deck",
    id: string,
    base_revision: number | null,
    name: string,
    query: CardQuery,
  }
  | {
    "op": "delete_deck",
    id: string,
    base_revision: number,
  }
  | {
    "op": "save_task_view",
    id: string,
    base_revision: number | null,
    name: string,
    query: TaskQuery,
  }
  | {
    "op": "delete_task_view",
    id: string,
    base_revision: number,
  }
  | {
    "op": "save_library_view",
    id: string,
    base_revision: number | null,
    name: string,
    query: LibraryQuery,
  }
  | {
    "op": "delete_library_view",
    id: string,
    base_revision: number,
  };

export type OtherBackups = {
  workshop_id: string,
  /**
   * The folder name recorded by its newest backup, when it recorded one.
   */
  name: string | null,
  count: number,
  size: number,
  newest_at: number | null,
  path: string,
};

export type PageReferences = {
  total: number,
  groups: Array<ReferenceGroup>,
};

/**
 * Everything needed to show one page.
 */
export type PageView = {
  root: Block,
  /**
   * Explicit tags on the page itself, separate from descendant memberships.
   */
  root_manual_types?: Array<string>,
  /**
   * Live descendants in preorder, including archived ones (flagged).
   */
  rows: Array<Row>,
  /**
   * Live blocks outside this page that its rows reference, and the pages
   * named by its tags. A missing reference target is unresolved.
   */
  targets: Array<Block>,
  capabilities?: Array<BlockCapabilities>,
};

/**
 * A paired device as the Mac lists it: its pairing, whether it syncs, and how its last attempts went.
 */
export type PairedDevice = {
  id: string,
  name: string,
  paired_at: number,
  state: "active" | "retired" | "never_synced",
  last_seen_at: number | null,
  retired_at: number | null,
  version: SyncVersion | null,
  last_attempt_at: number | null,
  refused: Refused | null,
  attempts: Array<SyncAttempt>,
};

export type PairedDeviceIdentity = {
  id: string,
  name: string,
};

export type PairedHub = {
  name: string,
  notebook_id: string,
  schema_version: number,
};

/**
 * The code a new device types or scans to join, and when it stops working.
 */
export type PairingCode = {
  code: string,
  display: string,
  expires_at: number,
  url: string,
  qr_svg: string,
};

/**
 * The device a pairing code admitted.
 */
export type PairingDevice = {
  id: string,
  name: string,
};

export type PairingStatus = {
  state: "none" | "waiting" | "paired" | "expired",
  device: PairingDevice | null,
};

export type Passage = {
  id: string,
  ordinal: number,
  kind: PassageKind,
  level: number | null,
  text: string,
  locator: string,
  anchor: string | null,
  resource: string | null,
  marks: Array<Mark>,
  start: number,
};

export type PassageHit = {
  source_id: string,
  title: string,
  snapshot_id: string,
  passage: Passage,
  snippet_parts: Array<SnippetPart>,
};

export type PassageKind =
  | "heading"
  | "paragraph"
  | "quote"
  | "list_item"
  | "code"
  | "footnote"
  | "image";

export type PassagePage = {
  passages: Array<Passage>,
  citations: Array<Citation>,
  total: number,
  toc: Array<TocEntry>,
};

export type PassagePoint = {
  passage_id: string,
  offset: number,
};

export type PersonFacet = {
  id: string | null,
  name: string,
  count: number,
};

export type PositionField = {
  field_id: string,
  entry_id: string,
  values: Array<FieldOption>,
};

export type PositionInfo = {
  holder_id: string | null,
  subject_id: string,
  /**
   * Last-known attribution, without treating a tombstoned page as a live holder.
   */
  deleted_holder?: FieldOption | null,
  /**
   * Why the holder is not an entity. The block stays a perspective; the problem only asks for a fix.
   */
  problem?: string | null,
};

export type PositionQuery = {
  holder?: string,
  subject?: string,
  limit?: number,
};

export type PositionQueryResult = {
  rows: Array<PositionRow>,
  criteria: SubjectCriteria,
  questions: Array<PositionQuestion>,
};

export type PositionQuestion = {
  block: BlockInPage,
  info: QuestionInfo,
  criterion: string | null,
  holders: Array<string>,
};

export type PositionRow = {
  block: BlockInPage,
  holder_id: string | null,
  subject_id: string,
  deleted_holder?: FieldOption | null,
  fields: Array<PositionField>,
};

export type ProjectRecord = {
  block_id: string,
  state: ProjectState,
};

export type ProjectState = {
  outcome: string,
  deadline: string | null,
  status: ProjectStatus,
};

export type ProjectStatus = "active" | "done" | "cancelled";

export type ProviderInput = {
  id?: string | null,
  name: string,
  protocol: ProviderProtocol,
  base_url: string,
  model: string,
  api_key?: string | null,
};

export type ProviderProtocol = "anthropic" | "openai";

export type ProviderTestResult = {
  ok: boolean,
};

export type ProviderView = {
  id: string,
  name: string,
  protocol: ProviderProtocol,
  base_url: string,
  model: string,
  has_key: boolean,
};

/**
 * A provisional tag page removed by derivation, retained for exact history replay.
 */
export type PrunedPage = {
  id: string,
  deletion_id: string,
  revision: number,
};

export type Query = {
  source?: QuerySource,
  layout?: QueryLayout,
  type: string | null,
  text: string | null,
  filters: Array<Filter>,
  sort: Array<SortKey>,
  limit: number | null,
  /**
   * Rows skipped after sorting; total and column metadata cover all matches.
   */
  offset?: number,
  /**
   * Restrict to this finding-aid kind's members, including inline capability atoms.
   */
  note_kind?: string,
  links?: Array<string>,
  from?: Array<string>,
  cites?: Array<string>,
  /**
   * Presentation travels in the existing saved query JSON, not a second view store.
   */
  note_view?: NoteView,
  columns?: Array<QueryColumn>,
  group?: QueryGrouping,
  card?: Array<string>,
  purpose?: string,
  desk?: DeskQuery,
  /**
   * Remembered labels for references left behind by field detachment or deletion.
   */
  field_names?: {
    [key in string]: string
  },
};

export type QueryAttribute = {
  key: string,
  name: string,
  kind: FieldKind,
};

export type QueryAttributeValue = {
  text: string,
  reading: Reading,
};

export type QueryColumn = {
  key: string,
  width?: number,
};

export type QueryGroup = {
  key: string,
  title: string,
  target: string | null,
  row_ids: Array<string>,
  count: number,
};

export type QueryGrouping = {
  key: string,
  collapsed?: Array<string>,
};

export type QueryLayout = "table" | "register" | "matrix" | "desk";

export type QueryResult = {
  fields: Array<FieldDefinition>,
  columns: Array<string>,
  rows: Array<QueryRow>,
  total: number,
  note_groups?: Array<NoteGroup>,
  attributes?: Array<QueryAttribute>,
  groups?: Array<QueryGroup>,
};

export type QueryRow = {
  block: BlockInPage,
  values: {
    [key in string]: Array<FieldValue>
  },
  attributes?: {
    [key in string]: Array<QueryAttributeValue>
  },
};

export type QuerySource = "notes" | "questions" | "positions" | "sources" | "tasks" | "highlights";

export type QuestionFilter = "active" | "recurrent" | "due" | "answered" | "parked";

export type QuestionInfo = {
  state: QuestionState,
  status: QuestionStatus,
  parent_id: string | null,
  parent_explicit: boolean,
};

export type QuestionQuery = {
  status?: QuestionStatus,
  review_by?: string,
  parent?: string,
  state?: QuestionFilter,
  include_inline?: boolean,
  limit?: number,
};

export type QuestionRow = {
  block: BlockInPage,
  info: QuestionInfo,
  position_count: number,
  current: CurrentReading | null,
  review_on: string | null,
};

export type QuestionState = {
  unsettled: boolean,
  parked: boolean,
  review_on: string | null,
  accepted: string | null,
  parent?: string | null,
  reading_history?: Array<ReadingDecision>,
};

export type QuestionStatus = "open" | "answered" | "parked" | "unsettled";

export type QuoteState = {
  target_id: string,
  captured_at: number,
  rows: Array<QuotedRow>,
  truncated: boolean,
};

export type QuoteStatus = {
  block_id: string,
  source_live: boolean,
  changed: boolean,
};

export type QuotedRow = {
  id: string,
  depth: number,
  text: string,
  heading: 1 | 2 | 3 | null,
  revision: number,
};

export type Reading =
  | {
    ok: true,
    value: ReadingValue,
    target: string | null,
  }
  | {
    ok: false,
    problem: string,
  };

export type ReadingDecision = {
  assessment_id: string,
  status: ReadingStatus,
  on: string,
};

export type ReadingPosition = {
  snapshot_id: string,
  passage_ordinal: number,
  updated_at: number,
};

export type ReadingProgress = {
  position: ReadingPosition,
  /**
   * The reading position as a share of the text: the characters before its passage.
   */
  progress: number,
  state_changed: boolean,
  seq: number | null,
};

export type ReadingState = "inbox" | "reading" | "finished" | "abandoned";

export type ReadingStatus = "current" | "superseded" | "withdrawn";

export type ReadingValue = string | number | boolean | YearSpan;

export type RecipeDetail = {
  field_id: string,
  label: string,
  value: string,
  prose: boolean,
};

export type Rect = {
  x: number,
  y: number,
  w: number,
  h: number,
};

export type ReferenceCount = {
  block_id: string,
  count: number,
};

export type ReferenceGroup = {
  page: Block,
  sources: Array<ReferenceSource>,
};

export type ReferenceSource = {
  source: Block,
  targets: Array<string>,
};

export type Refused = {
  code: string,
  message: string,
  since: number,
  attempts: number,
};

export type RejectedChange = {
  id: string,
  change_id: string,
  error: string,
  created_at: number,
  origin: string,
  origin_name: string | null,
  mine: boolean,
  page_id: string | null,
  page_title: string | null,
  texts: Array<string>,
};

export type RelationEndpoint = {
  block: BlockInPage,
  holder_id: string | null,
};

export type RelationInfo = {
  kind: RelationKind,
  source_id: string,
  target_id: string | null,
  problem: string | null,
};

export type RelationKind = "supports" | "disputes" | "qualifies" | "answers";

export type RelationQuery = {
  kind?: RelationKind,
  source?: string,
  target?: string,
  source_holder?: string,
  target_holder?: string,
  /**
   * Relations between two perspectives filed under this page or a block on it, as a concept page's
   * constellation draws them.
   */
  subject?: string,
  limit?: number,
};

export type RelationRow = {
  block: BlockInPage,
  kind: RelationKind,
  source: RelationEndpoint,
  target: RelationEndpoint | null,
  problem: string | null,
};

export type RepeatMode = "fixed" | "catch_up" | "after_completion";

export type RepeatUnit = "day" | "week" | "month" | "year";

/**
 * A positive interval whose next occurrence must fit the civil date range.
 */
export type Repeater = {
  every: number,
  unit: RepeatUnit,
  mode: RepeatMode,
};

/**
 * Replica side: this device's copy of a hub's workshop.
 */
export type ReplicaState = {
  hub_url: string,
  hub_name: string | null,
  device_name: string | null,
  device_id: string,
  pending: number,
  unapplied: number,
  synced_at: number | null,
  syncing: boolean,
  last_error: LastError | null,
  retired: boolean,
  hub_version: SyncVersion | null,
  failing_since: number | null,
  attempts: Array<SyncAttempt>,
  kept_copies: number,
  rejected: number,
  offline: OfflineFiles,
};

export type RequiredField = {
  field_id: string,
  /**
   * Members with no nonblank value for the field.
   */
  missing: number,
};

export type RestoringBackup = {
  restoring: true,
  backup: BackupInfo,
  safety: BackupInfo | null,
};

export type RetainedPatches = {
  changes: number,
  bytes: number,
};

export type ReviewEvent = {
  id: string,
  card_id: string,
  session_id: string | null,
  kind: ReviewEventKind,
  grade: Grade | null,
  shown_front: string,
  shown_back: string,
  definition_revision: number,
  scheduler_version: string,
  before: ReviewSchedulingState,
  after: ReviewSchedulingState,
  created_at: number,
  change_seq: number,
  /**
   * Original evidence remains readable after an immutable correction.
   */
  undone_by: string | null,
};

export type ReviewEventKind = "grade" | "reset";

export type ReviewForecastDay = {
  date: string,
  count: number,
};

/**
 * Retained evidence is not rewritten when changing scheduling algorithms.
 */
export type ReviewSchedulingState =
  | {
    ease_factor: number,
    interval_days: number,
    repetitions: number,
    lapses: number,
    due_at: number,
    last_reviewed_at: number | null,
  }
  | SchedulingState;

export type ReviewSession = {
  id: string,
  deck_id: string | null,
  started_at: number,
  ended_at: number | null,
  state: ReviewSessionState,
  revision: number,
};

export type ReviewSessionState = "open" | "finished" | "abandoned";

export type ReviewStats = {
  date: string,
  due_review: number,
  due_new: number,
  forecast: Array<ReviewForecastDay>,
  retention: number | null,
  reviews_past_week: number,
  streak: number,
  total_cards: number,
  held_cards: number,
};

export type Revision = {
  id: string,
  revision: number,
};

export type RevisitAction = "revisited" | "later" | "resolve" | "reopen" | "keep_recurrent";

export type RevisitEvent = {
  id: string,
  block_id: string,
  revisited_on: string,
  next_on: string | null,
  created_at: number,
  change_seq: number,
  actor: Actor,
};

export type RevisitRow = {
  block: BlockInPage,
  note: NoteState,
  question_status: QuestionStatus | null,
  revisit_on: string,
  last_revisited_on: string | null,
  proposed_on: string,
};

export type RevisitSnapshot = {
  note: NoteState,
  question: QuestionState | null,
};

/**
 * A block in a page, in reading (preorder) order.
 */
export type Row = {
  block: Block,
  /**
   * 0 for the root's children.
   */
  depth: number,
  manual_types: Array<string>,
};

/**
 * What a safety backup was taken before. Retention keeps these for a week.
 */
export type Safety = "update" | "restore";

export type SaveAgentProviders = {
  providers: Array<ProviderInput>,
  default: string | null,
};

export type SchedulingState = {
  stability: number | null,
  difficulty: number | null,
  interval_days: number,
  repetitions: number,
  lapses: number,
  /**
   * Absolute Unix timestamp in milliseconds.
   */
  due_at: number,
  last_reviewed_at: number | null,
};

export type SeeTarget = {
  id: string,
  title: string,
};

export type ServiceInfo = {
  version: string,
  /**
   * The commit a release or `ts-ship` built from; absent in development builds.
   */
  build: string | null,
  port: number,
  assets: "embedded" | "directory" | "none",
  launch_agent: LaunchAgentInfo,
};

export type Setting = {
  key: string,
  value: string,
  revision: number,
  updated_at: number,
};

export type SettingRevision = {
  key: string,
  revision: number,
};

export type SettingsView = {
  settings: Array<Setting>,
  today: string,
  time_zone: string,
};

/**
 * The finding-aid group a kind is listed under in the sidebar.
 */
export type Shelf = "notes" | "sources" | "work" | "tags" | "loose";

export type SiglumDisambiguation = {
  year: string | null,
  title_initial: string | null,
};

export type SnapshotSummary = {
  id: string,
  sha256: string,
  format: SourceFormat,
  media_type: string,
  metadata: ExtractedMetadata,
  passage_count: number,
  text_length: number,
  attached_at: number,
  change_seq: number,
};

/**
 * Plain source text and whether it matched the full-text query. No inline delimiters are exposed.
 */
export type SnippetPart = {
  text: string,
  match: boolean,
};

export type SortBy = "title" | "created" | "updated" | "field";

export type SortKey = {
  by: SortBy,
  field: string | null,
  direction: Direction,
};

export type SourceFormat = "epub" | "article" | "record";

export type SourceRecord = {
  block_id: string,
  format: SourceFormat,
  state: ReadingState,
  origin: string | null,
  match_key: string | null,
  citation_key: string | null,
  added_at: number,
  state_changed_at: number,
  last_read_at: number | null,
  current_snapshot_id: string | null,
  /**
   * Empty in change results stored before sigla existed; current reads always fill it.
   */
  siglum: string,
  siglum_basis: string,
  siglum_authored: boolean,
  /**
   * Current author-derived collision hints; never a persisted siglum assignment.
   */
  siglum_disambiguation: SiglumDisambiguation | null,
};

export type SourceState = {
  format: SourceFormat,
  state: ReadingState,
  origin: string | null,
  match_key: string | null,
  citation_key: string | null,
};

export type SourceSummary = {
  siglum: string,
  citation_key: string | null,
  format: SourceFormat,
  /**
   * The work's Form reading, such as `paper`, which names it better than its format.
   */
  form: string | null,
  /**
   * The byline's creators in order; a linked creator carries its page id so the byline can open it.
   */
  authors: Array<LibraryPerson>,
  publisher: string | null,
  published: string | null,
  highlights: number,
};

export type SourceView = {
  source: SourceRecord,
  page: Block,
  snapshots: Array<SnapshotSummary>,
  toc: Array<TocEntry>,
  position: ReadingPosition | null,
  progress: number,
};

export type Spread = {
  note_ids: Array<string>,
  columns: Array<SpreadColumn>,
  fields: Array<SpreadField>,
  /**
   * Only saved spreads have reference block identities.
   */
  references: Array<SpreadReference>,
};

export type SpreadColumn = {
  id: string,
  title: string,
  kinds: Array<NoteKind>,
  gloss: Array<SpreadValue>,
  sources: Array<SpreadValue>,
  links: Array<SpreadValue>,
  opening: Array<SpreadValue>,
};

export type SpreadField = {
  id: string,
  name: string,
  /**
   * Aligned with columns; an absent or empty field is an empty cell.
   */
  cells: Array<Array<SpreadValue>>,
};

export type SpreadReference = {
  block_id: string,
  note_id: string,
};

export type SpreadValue = {
  text: string,
  target_id: string | null,
  shared: boolean,
  between_columns: boolean,
};

export type StagedSnapshot = {
  id: string,
  existing: boolean,
};

export type StartAgentTurn = {
  provider: string,
  prompt: string,
  messages: Array<ThreadMessage>,
  context: Array<ContextRef>,
};

export type StreamArrival = {
  block: Block,
  page: Block,
  anchor_id: string,
};

export type SubjectCriteria = {
  explicit: boolean,
  fields: Array<string>,
};

export type Subtree = {
  /**
   * Includes the root at depth 0, followed by its visible descendants.
   */
  rows: Array<Row>,
  truncated: boolean,
};

export type SummaryField = {
  name: string,
  value: string,
};

export type Surfacing = {
  action: "kept" | "opened" | "muted" | null,
  block: BlockInPage,
  citation: Citation,
  source_title: string,
  processed: boolean,
  notes: number,
  triage: Citation["triage"],
  color: Citation["color"],
  tags: Array<string>,
  created_at: number,
};

export type SurfacingBody = {
  date: string,
  action: "kept" | "opened" | "muted",
};

export type SyncAttempt = {
  at: number,
  first_at: number,
  ok: boolean,
  code: string | null,
  message: string | null,
  count: number,
};

export type SyncConflicts = {
  kept: Array<KeptCopyRow>,
  rejected: Array<RejectedChange>,
};

export type SyncDevices = {
  this_device: SyncVersion,
  sharing: SyncSharing,
  hub_name: string,
  devices: Array<PairedDevice>,
  retained: RetainedPatches,
};

/**
 * Hub side: Tailscale Serve publishing this Mac's sync listener.
 */
export type SyncSharing = {
  available: boolean,
  on: boolean,
  url: string | null,
  error: string | null,
};

export type SyncState = {
  this_device: SyncVersion,
  role: "hub" | "replica" | "none",
  replica: ReplicaState | null,
};

/**
 * What a device running Tessera reports about itself. A peer that reports only its schema
 * leaves `version` and `build` null.
 */
export type SyncVersion = {
  version: string | null,
  build: string | null,
  schema: number,
};

export type TagDeck = {
  id: string,
  name: string,
  query: CardQuery,
};

export type TaskFilter = {
  selection: TaskSelection,
  statuses: Array<TaskStatus>,
  recent_days: number,
  scheduled: DateRange | null,
  deadline: DateRange | null,
  priority: TaskPriority | null,
  project_id: string | null,
  sort?: TaskSort,
  project_via?: TaskProjectVia,
};

export type TaskOccurrence = {
  id: string,
  block_id: string,
  completed_on: string,
  snapshot: TaskState,
  reversed: boolean,
  created_at: number,
  change_seq: number,
};

export type TaskPriority = "high" | "medium" | "low";

export type TaskProjectVia = "both" | "field";

export type TaskQuery = {
  source: Query | null,
  filter: TaskFilter,
  context_date: string,
  limit: number | null,
};

export type TaskQueryResult = {
  rows: Array<TaskRow>,
  total: number,
};

export type TaskRecord = {
  block_id: string,
  state: TaskState,
};

export type TaskRow = {
  source: BlockInPage,
  task: TaskState,
  project_id: string | null,
  section_id: string | null,
  section_text: string | null,
  /**
   * Total of this task's stopped, unreversed work sessions, in milliseconds.
   */
  logged_work_ms?: number,
};

export type TaskSelection = "all" | "unfinished" | "unfinished_or_recent";

export type TaskSort = "plan" | "outline";

export type TaskState = {
  status: TaskStatus | null,
  scheduled: string | null,
  scheduled_time: string | null,
  deadline: string | null,
  deadline_time: string | null,
  warning_days: number | null,
  repeater: Repeater | null,
  priority: TaskPriority | null,
  completed_on: string | null,
};

export type TaskStatus = "todo" | "doing" | "waiting" | "done" | "cancelled";

export type TaskView = {
  id: string,
  name: string,
  query: TaskQuery,
  revision: number,
  created_at: number,
  updated_at: number,
};

export type TemplateLoadDay = {
  date: string,
  due: number,
  added: number,
};

/**
 * A source considered for automatic tag rewriting during a page rename.
 * Equal-text entries are revision-checked spelling guards for undo.
 */
export type TextRewrite = {
  id: string,
  before: string,
  after: string,
  revision: number,
};

export type ThreadMessage = {
  role: ThreadRole,
  text: string,
};

export type ThreadRole = "user" | "assistant";

export type TocEntry = {
  title: string,
  locator: string,
  /**
   * 1 for top-level entries.
   */
  level: number,
  /**
   * Resolved passage ordinal in the snapshot; absent during extraction.
   */
  ordinal: number | null,
  /**
   * The resolved passage's character offset in the snapshot text, for time left and chapter maps; absent during
   * extraction and never stored.
   */
  start?: number,
};

/**
 * Workshop-wide data that a change can alter. A client keys each list it
 * fetches on the topics that list reads.
 */
export type Topic =
  | "fields"
  | "types"
  | "pages"
  | "inquiry"
  | "tasks"
  | "cards"
  | "library"
  | "revisits"
  | "views"
  | "sync";

export type TurnEvent = {
  n: number,
} & ({
  "kind": "text",
  delta: string,
} | {
  "kind": "tool",
  name: string,
  summary: string,
} | {
  "kind": "edit",
  seq: number,
  summary: string,
  page: string | null,
  blocks: Array<string>,
} | {
  "kind": "error",
  message: string,
} | {
  "kind": "done",
  stop: TurnStop,
});

export type TurnStop = "end" | "cancelled" | "limit" | "error";

export type Type = {
  page: Block,
  plural: string | null,
  icon: string | null,
  fields: Array<string>,
  members: number,
  card_templates: number,
  /**
   * Template fields the type's built-in schema requires, in template order.
   */
  required: Array<RequiredField>,
  /**
   * Field names the built-in starting template would add to an empty template; empty otherwise.
   */
  starting: Array<string>,
};

export type UndoReceipt = {
  /**
   * The undo's own change in the history log: pass it to
   * [`Workshop::undo_change`] to redo. Editor routes rewrite
   * `committed.seq` to their arrival cursor; this stays the log's number.
   */
  seq: number,
  undone: number,
  /**
   * Pages the change created that were kept because they are now in use
   * or were renamed.
   */
  kept_pages: Array<Block>,
  committed: Committed,
};

export type UnlinkedMentions = {
  total: number,
  rows: Array<Mention>,
};

export type ValueFacet = {
  value: string,
  count: number,
};

export type View = {
  id: string,
  name: string,
  query: Query,
  revision: number,
  created_at: number,
  updated_at: number,
};

export type WorkSession = {
  id: string,
  block_id: string,
  started_at: number,
  ended_at: number | null,
  note: string,
  reversed: boolean,
  revision: number,
};

export type WorkshopInfo = {
  id: string,
  path: string,
  created_at: number,
  schema_version: number,
  sqlite_version: string,
};

export type WorkshopSize = {
  size: number,
};

export type YearFacet = {
  year: number,
  count: number,
};

/**
 * Inclusive historical years; missing bounds are open, and BCE years are negative.
 */
export type YearSpan = {
  from: number | null,
  through: number | null,
};
