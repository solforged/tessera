/**
 * JSON shapes of the service API (snake_case, as serialized). `wire.ts` is
 * written from the Rust types by `mise run wire`; the shapes below it are the
 * service's own and still mirror `crates/tessera-service/src/` by hand.
 */
export type * from './wire';
import type {
  Block,
  ExtractedMetadata,
  FieldSummary,
  RejectedChange,
  RequiredField,
} from './wire';

export interface ProviderView {
  id: string;
  name: string;
  protocol: 'anthropic' | 'openai';
  base_url: string;
  model: string;
  has_key: boolean;
}

export interface ProviderInput {
  id?: string;
  name: string;
  protocol: 'anthropic' | 'openai';
  base_url: string;
  model: string;
  api_key?: string | null;
}

export interface AgentProviders { providers: ProviderView[]; default: string | null }
export interface SaveAgentProviders { providers: ProviderInput[]; default: string | null }
export interface ThreadMessage { role: 'user' | 'assistant'; text: string }
export interface ContextRef { page_id: string; block_id?: string }
export interface StartAgentTurn {
  provider: string;
  prompt: string;
  messages: ThreadMessage[];
  context: ContextRef[];
}
export interface AgentTurnStarted { turn: string }
export type TurnEvent =
  | { n: number; kind: 'text'; delta: string }
  | { n: number; kind: 'tool'; name: string; summary: string }
  | { n: number; kind: 'edit'; seq: number; summary: string; page: string | null; blocks: string[] }
  | { n: number; kind: 'error'; message: string }
  | { n: number; kind: 'done'; stop: 'end' | 'cancelled' | 'limit' | 'error' };
export interface AgentTurnEvents { events: TurnEvent[]; done: boolean }

export interface NotebookSize { size: number }

export interface ServiceInfo {
  version: string;
  build: string | null;
  port: number;
  assets: 'embedded' | 'directory' | 'none';
  launch_agent: { installed: boolean; path: string | null };
}

export interface BackupInfo { path: string; name: string; created_at: number; object_count: number; size: number; safety: 'update' | 'restore' | null }
export interface OtherBackups { workshop_id: string; name: string | null; count: number; size: number; newest_at: number | null; path: string }
export interface Backups { backups: BackupInfo[]; store_size: number; others: OtherBackups[]; automatic_failure: { at: number; message: string } | null }
export interface CreatedBackup { created: boolean; backups: Backups }
export interface RestoringBackup { restoring: true; backup: BackupInfo; safety: BackupInfo | null }
/**
 * A workshop the switcher knows. `available` is false when its folder no longer holds a workshop; `display_path`
 * writes the home folder as `~`; `named` marks one made by name in the workshops folder.
 */
export interface KnownNotebook { path: string; display_path: string; name: string; current: boolean; default: boolean; available: boolean; named: boolean }
export interface KnownNotebooks { notebooks: KnownNotebook[] }

/** Hub side: Tailscale Serve publishing this Mac's sync listener. */
export interface SyncSharing { available: boolean; on: boolean; url: string | null; error: string | null }
export interface SyncVersion { version: string | null; build: string | null; schema: number }
export interface SyncAttempt { at: number; first_at: number; ok: boolean; code: string | null; message: string | null; count: number }
export interface PairedDevice {
  id: string; name: string; paired_at: number; state: 'active' | 'retired' | 'never_synced';
  last_seen_at: number | null; retired_at: number | null; version: SyncVersion | null; last_attempt_at: number | null;
  refused: { code: string; message: string; since: number; attempts: number } | null; attempts: SyncAttempt[];
}
export interface SyncDevices { this_device: SyncVersion; sharing: SyncSharing; hub_name: string; devices: PairedDevice[]; retained: { changes: number; bytes: number } }
export interface PairingCode { code: string; display: string; expires_at: number; url: string; qr_svg: string }
export interface PairingStatus { state: 'none' | 'waiting' | 'paired' | 'expired'; device: { id: string; name: string } | null }
/** Replica side: this device's copy of a hub's notebook. */
export interface ReplicaState {
  hub_url: string; hub_name: string | null; device_name: string | null; device_id: string;
  pending: number; unapplied: number; synced_at: number | null; syncing: boolean;
  last_error: { code: string; message: string } | null; retired: boolean;
  hub_version: SyncVersion | null; failing_since: number | null; attempts: SyncAttempt[];
  kept_copies: number; rejected: number; offline: { books: number; bytes: number };
}
export interface SyncState { this_device: SyncVersion; role: 'hub' | 'replica' | 'none'; replica: ReplicaState | null }
export interface KeptCopyRow { id: string; of: string; page_id: string; page_title: string; text: string; origin: string; origin_name: string | null; mine: boolean; created_at: number }
export interface SyncConflicts { kept: KeptCopyRow[]; rejected: RejectedChange[] }

/** `error.details` of a 409 response. */
export interface ConflictDetails {
  op_index: number;
  id: string;
  expected: number;
  found: number | null;
}

export interface Fields { page_id: string; fields: FieldSummary[] }
/** `starting` names the built-in starting template's fields while the template is empty. */
export interface Type { page: Block; fields: string[]; members: number; card_templates: number; plural: string | null; icon: string | null; required: RequiredField[]; starting: string[] }

export interface PositionFieldEntry { field_id: string; entry_id: string; values: { id: string; text: string }[] }

export interface CardTemplateState { type_id: string; name: string; front: string; back: string; hint?: string | null; details?: string[]; applied: boolean; new_per_day: number }

export interface LookupPreview { metadata: ExtractedMetadata; cover_url: string | null; provider: string }
/** Browse filters: AND across fields, OR within one; empty means no filter. `people` holds person page ids. */
export interface LibraryFilters { people: string[]; decades: number[]; years: number[]; publishers: string[]; languages: string[] }
export type SurfacingAction = 'kept' | 'opened' | 'muted';
