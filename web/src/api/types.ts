/**
 * JSON shapes of the service API. These mirror `crates/tessera-core/src/model.rs`
 * field for field (snake_case, as serialized). Change both together.
 */

export type BlockKind = 'block' | 'page' | 'journal';

export interface Block {
  id: string;
  kind: BlockKind;
  parent_id: string | null;
  page_id: string;
  /** A page's title; a journal's date as `YYYY-MM-DD`. */
  text: string;
  heading: 1 | 2 | 3 | null;
  archived: boolean;
  revision: number;
  created_at: number;
  updated_at: number;
}

export type Actor =
  | { kind: 'person' }
  | { kind: 'agent'; name: string }
  | { kind: 'client'; name: string };

export type Operation =
  | { op: 'create_page'; id: string; title: string }
  | { op: 'create_journal'; id: string; date: string }
  | { op: 'insert'; id: string; parent_id: string; after: string | null; text: string; heading: 1 | 2 | 3 | null }
  | { op: 'edit_text'; id: string; base_revision: number; text: string }
  | { op: 'set_heading'; id: string; base_revision: number; heading: 1 | 2 | 3 | null }
  | { op: 'split'; id: string; base_revision: number; new_id: string; left: string; right: string }
  | { op: 'merge'; source_id: string; source_revision: number; destination_id: string; destination_revision: number }
  | { op: 'move'; id: string; base_revision: number; parent_id: string; after: string | null }
  | { op: 'delete'; id: string; base_revision: number }
  | { op: 'restore'; id: string; deletion_id: string; revision: number }
  | { op: 'set_archived'; id: string; base_revision: number; archived: boolean };

export interface Batch {
  actor: Actor;
  reason?: string | null;
  idempotency_key?: string | null;
  operations: Operation[];
}

export interface Revision {
  id: string;
  revision: number;
}

export interface Committed {
  seq: number;
  /** Resulting revision of every block the batch changed, in first-touched order. */
  revisions: Revision[];
  /** Deletion events created by `delete` and `merge`, in operation order. */
  deletions: string[];
  replayed: boolean;
  /**
   * Source text the service rewrote on its own, such as tag tokens after a
   * page rename. Every matched source is listed, even when `before` equals
   * `after`, so undo can restore exact spellings with a revision check.
   */
  text_rewrites: TextRewrite[];
}

export interface TextRewrite {
  id: string;
  before: string;
  after: string;
  /** The block's revision after the rewrite. */
  revision: number;
}

export interface Row {
  block: Block;
  depth: number;
}

export interface PageView {
  root: Block;
  /** Live descendants in preorder, archived ones included and flagged. */
  rows: Row[];
  /** Live blocks outside the page that its rows reference, and the pages its tags name. */
  targets: Block[];
}

/** A block shown with its page: backlinks, search hits and type members. */
export interface BlockInPage {
  block: Block;
  page: Block;
}

export interface Backlink {
  source: Block;
  page: Block;
}

/**
 * One committed batch as clients see it, from `GET /api/changes` and the
 * `/api/changes/stream` WebSocket. Block state is current, not historical:
 * `blocks` holds the live state of blocks this change touched, `removed` the
 * touched IDs that are no longer live, and `restructured_pages` the pages
 * whose order or nesting this change altered.
 */
export interface ChangeEvent {
  seq: number;
  actor: Actor;
  reason: string | null;
  created_at: number;
  blocks: Block[];
  removed: string[];
  restructured_pages: string[];
}

export interface NotebookInfo {
  id: string;
  path: string;
  created_at: number;
  schema_version: number;
  sqlite_version: string;
}

/** `error.details` of a 409 response. */
export interface ConflictDetails {
  op_index: number;
  id: string;
  expected: number;
  found: number | null;
}
