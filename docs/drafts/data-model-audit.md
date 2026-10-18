# Data model audit

Working note, 2026-10-16. An audit of the notebook schema, the operation layer and sync against the two outliners Tessera borrows from most. It reads the migrations in `crates/tessera-core/migrations`, the operation engine, the replication classes and the design documents, and compares them with what is public about Tana and both Logseq generations. Proposals are ordered by value against cost. When one is built, its rules move into the domain model or sync document and this file is deleted.

## Verdict

Tessera's model is already closer to Tana's than to Logseq's, and in several places it is stricter than either: one block table with stable ULIDs, ID-addressed references, fields whose values are blocks, every behavior as a capability table keyed by block ID, and a change log that every client writes through. The parts that need work are the ones neither comparison product has solved well either: unbounded history, title-addressed tags, derived indexes without a repair path, and a query layer that filters in memory.

The three findings that matter most:

1. **Tags are the one title-addressed identity left in the model.** References moved to `[[id]]`; `#Type` still resolves through `title_key`, and a type rename rewrites authored text on every member. Two devices can disagree about which page a tag means.
2. **History grows without bound and cannot be repaired.** Every commit keeps its full operations JSON, its receipt and tombstones forever, and there is no integrity or rebuild command. Backups copy whatever state the file is in.
3. **Queries gather candidates in SQL and sort readings in Rust**, so field sorts and filters cost linear time in members. The measured 42,000-member table at 270 ms is the first sign.

## How the three models compare

| Dimension | Tessera | Tana | Logseq OG (files) | Logseq DB |
|---|---|---|---|---|
| Unit | Block row; pages and journal days are roots in the same table | Node; everything including fields, views and commands is a node | Block parsed from Markdown or Org; pages are files | Block entity in Datascript persisted to SQLite |
| Identity | Client-chosen ULID; IDs derived inside apply are hashed from the change | Server-assigned node ID | UUID only once referenced, written back as an `id::` property | `:block/uuid` on every entity |
| Reference | `[[id]]`, `[[id\|label]]`; links indexed; targets may be unresolved | Node reference by ID; a mirror shows live content | `[[Page name]]` and `((uuid))`; renames rewrite files | UUID references; names are properties |
| Typing | `#Type` by title key; type pages with ordered field templates; built-in kinds by title or capability | Supertags by ID, with inheritance, field templates and default values | `tags::` property by name | Classes as tagged entities with `extends` inheritance and typed property schema |
| Fields | Definition, entry and value are blocks; the index holds identities; kind interprets text at read time | Field definitions are nodes; instances are tuple nodes holding the definition and value nodes | `key:: value` text; typed loosely | First-class properties with declared type and cardinality, validated before write |
| Sibling order | Sparse integer ordinal, midpoint insertion, rebalanced on exhaustion | Ordered `children` array on the parent | File position | Fractional-index string key per block |
| History | Append-only change log with actor, operations, receipt and tombstones; review and task history as evidence tables | Server-side history; trash for deleted nodes | Git or file history, optional | Server-side operation log for synced graphs; none locally |
| Derived data | Links, memberships, field values, cards and FTS derived in the write transaction | Server indexes | Re-index rebuilds everything from files | Datascript indexes; full-text in a worker |
| Sync | One hub orders changes; replicas push, pull session patches and rebase; text conflicts kept as copies | Cloud-authoritative; desktop offline mode since 1.0.49 | Encrypted file sync | Worker-based RTC rewritten in 2026 with end-to-end encryption and offline conflict resolution |
| Storage | SQLite, WAL, FULL sync, STRICT tables, FTS5; objects by SHA-256 beside it | Proprietary cloud | Plain files | SQLite via wasm, serialized Datascript |

Sources for the Tana and Logseq columns are listed at the end.

## What Tessera does better

These are worth protecting while changing anything else.

- **Determinism inside apply.** Derived IDs hashed from the change (`derived_id` in `notebook.rs`), stamped timestamps and a test that two notebooks reach identical state from the same changes. Neither Logseq generation makes this guarantee; Tana does not need to because the server is authoritative.
- **Explicit replication classes.** `replication::TABLES` names how every table reaches a replica, and a test fails when a migration adds a table without a class. This is the single best reliability device in the codebase.
- **Capabilities instead of a property bag.** Tasks, questions, cards and sources add rows, not properties. Logseq OG's `todo` keywords and Tana's supertag fields both put behavioral state into text or generic fields.
- **Evidence tables.** Review events, task occurrences and work sessions are append-only with corrections as rows. Tana and Logseq keep schedule state only.
- **Natural-key merges with ID aliases.** Two devices creating the same page or journal day resolve to one root, and later references follow through `id_aliases`. Logseq RTC resolves this on the server; Logseq OG does not resolve it at all.

## Findings

Severity is about data loss or silent divergence first, then cost at 50,000 blocks and above.

### R1. Tags are addressed by title

Built in migration 051 and the web client: tags and memberships address page IDs, rename leaves member text alone, pills read live titles, and completion inserts IDs. Check reports and repairs tag derivation.

`memberships` keys on `title_key`, with `type_id` resolved at derivation time (`storage.rs::resolve_type`). A type rename runs `rewrite_incoming_tags`, which rewrites the text of every member block and reports `text_rewrites` to the client. The Unicode migration (047) had to widen the primary key to `(block_id, title, manual)` to keep "legacy canonical collisions", which is the schema admitting the key is not an identity.

Why it matters:

- Offline, device A renames `#Book` to `#Monograph` while device B tags a note `#Book`. The hub applies B's tag by title, finds no live `book` page, and creates a provisional type page. Membership silently splits. Every other identity in the model survives this because it is ID-addressed.
- A rename is a mass text edit. Undo, sync patches and conflict copies all scale with member count.
- Tana's supertags and Logseq DB's classes are both ID-addressed; Logseq OG's name-addressed tags are the thing its DB rewrite set out to remove.

### R2. History and tombstones grow without bound

`changes` keeps `operations` and `committed` JSON for every commit forever. `editor_events` duplicates the change header for cursor purposes. Blocks are tombstoned, never deleted, and `deletion_events` grows with them. The only pruning in the core is of `change_patches` once every active replica has pulled.

The domain model lists "how much change history to keep" as open. Logseq DB keeps no local history at all and Tana's lives on its servers, so neither is a model to copy. Tessera keeps the most and has no plan for it. At 50,000 blocks the changes table already costs tens of megabytes on launch paths that read it.

### R3. No integrity or repair path

There is no `integrity_check`, `quick_check` or `foreign_key_check` outside tests, no derived-index verifier, and no user-facing rebuild. Derived tables (`links`, `memberships`, `field_values`, `card_units` definitions, FTS) are rebuilt only inside migrations. Backups copy the file as it is, including any drift. Logseq OG's Re-index is crude but exists; Logseq DB added schema validation before every write in 2025.

### R4. Two parsers for the same text

Tokens, tags, card syntax and field shorthand are parsed twice: in Rust (`storage.rs`, `card_text.rs`, `fields.rs`) and in TypeScript (`text-tokens.ts`, `card-text.ts`, `query.ts`). Parity is held by a few comparison tests on enum order. `Name:: value` converts only in the browser; a raw API write stays shorthand until a client touches it. Logseq OG had this exact split between mldoc and the editor and spent years on its edge cases. Tessera already compiles `tessera-core` to wasm for the demo, so the fix is cheaper here than it was there.

### R5. One connection behind one lock

The service holds a single connection behind a mutex, so page reads, agent context queries, sync steps and writes take turns. WAL already allows concurrent readers against the committed snapshot. The budgets still pass today because each operation is small, but any slow read (a 42,000-member table at 270 ms) blocks typing in every window for its duration.

### R6. Query evaluation is linear in members

`query_sources` gathers candidates by membership, FTS or field ownership, then filters, sorts and limits readings in Rust. Field comparison requires reading value text through the kind on every query. Offset pagination re-sorts everything. Tana's search nodes are indexed server-side; Logseq runs Datalog over an in-memory index, fast until memory runs out. Tessera's design choice (never store a copy of value text) is sound for correctness and wrong for sorting.

### R7. Strict tables are inconsistent

Migrations 001 to 010 and most later ones use `STRICT`; the library tables in 011 (`snapshots`, `passages`, `sources`, `citations`, `reading_positions`, `ingest_jobs` and others), `highlight_surfacings` (015) and `editor_events` (028) do not. Type affinity can store text in an INTEGER column there, and the replication test cannot catch it.

### R8. Divergence is detected only by patch failure

A replica discovers it has diverged when a session patch fails to apply and then reclones. A patch can apply cleanly to a state that already differs in a row the patch does not touch, so divergence can persist unnoticed. The sync document's blind-sequencer future depends on every device computing the same state, which makes detecting the opposite a requirement rather than a nicety.

### R9. JSON state columns carry no version

`tasks.state`, `questions.state`, `card_units.schedule`, `views.query` and `changes.operations` are JSON read through serde with defaults. `user_version` guards the database as a whole and `x-tessera-schema` guards sync, which covers the current single-user case. The domain model notes that older label-only filters migrate when a title identifies one page, which is a JSON migration done by hand. Each future JSON shape change will need the same.

### R10. Smaller observations

- `blocks_live_title` is a plain index after 047, with uniqueness enforced by triggers. The triggers are correct, but a unique partial index was self-documenting and cheaper. Worth restoring once legacy collisions are resolved.
- Prepending repeatedly subtracts 1024 per insert, so ordinals go negative. The reference query handles the sign bit explicitly. Harmless, but every consumer of `ordinal` must remember it.
- The `Fields` page is found by `title_key = 'fields'` in migration 043. The runner creates it with a canonical ULID, so this is safe today, but the same title-addressing as R1.
- `passages_fts` has an insert trigger only. Snapshots are immutable, so this holds while nothing ever deletes a passage.

## Proposals

Ordered by value over cost. Each names the finding it addresses, what it borrows and what it would take.

### P1. `tessera check`: verify and repair

Addresses R3, R7, R8. A core function and CLI command that, under the writer lock:

1. Runs `PRAGMA quick_check` and `PRAGMA foreign_key_check`.
2. Recomputes every derived table into temporary tables (`links`, `memberships` with `manual = 0`, `field_values`, card definitions, `search_blocks`) and reports the difference without writing.
3. Checks model invariants SQL can express: one live root per title key and journal date, `page_id` equal to the root's for every descendant, no live block under a tombstoned parent, every `card_units` row with retained history still pointing at a live or tombstoned source.
4. With `--repair`, replaces derived tables with the recomputed ones inside one transaction and records a change row with the `check` actor.
5. Prints a per-table content hash of the Applied class, ordered by primary key.

Backup and install run the read-only part and refuse to proceed on a failed `quick_check`. Cost: a few days. Risk: low; it writes only derived tables and only when asked.

### P2. Exchange state hashes during sync

Addresses R8. Use P1's per-table hashes. After a pull, a replica sends the hashes of its Applied tables at the confirmed sequence; the hub compares with its own at that sequence (computed once per prune and cached). A mismatch is reported in `/api/sync/state` and Settings › Devices as "diverged, reclone recommended" rather than waiting for a patch to fail. Cost: small once P1 exists. This is also the first piece the blind-sequencer design needs.

### P3. Tags addressed by ID

Built. `text_rewrites` stays for normalization, removal and merging, not rename. The editor accepts normalized text and keeps the caret and undo history. Migration leaves unresolved legacy tags in the text for check to report.

Addresses R1. Make a tag canonical as `#[[id|Title]]`, the same shape references already use, and derive memberships from the ID. The spelling after the bar is display only and is rewritten lazily when the block is next edited, never in bulk.

- Hand-typed `#Title` resolves at commit exactly as hand-typed `[[Title]]` does today: one match links, none creates, several stay unlinked and marked. The client already does this for references.
- `memberships` drops `title_key` and `title` as keys, keeping `type_id` as the identity and `title` as the authored spelling for display.
- Renaming a tag page touches one row. `rewrite_incoming_tags` and `prepare_tag_rename` are gone; `text_rewrites` remains for normalization.
- Migration rewrites `#Title` tokens to `#[[id|Title]]` once, resolving by the current title key, and records unresolvable ones as unlinked tags exactly as a hand-typed ambiguous reference is marked today.

Borrowed from Tana's supertags and Logseq DB's classes. Cost: the largest proposal here, perhaps two weeks including the editor's tag completion and rendering. Risk: a one-time text migration, so it needs P1 first and a pre-migration backup, which install already takes.

### P4. Tiered history retention

Addresses R2. Keep every change header (seq, change ID, origin, actor, reason, created_at, revisions) forever, since attribution and undo depend on them. Age out the payloads in tiers, each a setting with a default:

| Age | Keep |
|---|---|
| Under 7 days | Everything, including `committed` receipts for idempotent replay |
| Under 90 days, or not yet pulled by every active replica | Operations and tombstones; drop receipts |
| Older | Change headers and tombstone rows with `text` cleared, so IDs, foreign keys and restore tickets still resolve |

Rules that keep this safe:

- Nothing ages out past the oldest active replica's cursor or the newest backup's sequence.
- Tombstones referenced by evidence rows (`review_events` through `card_units`, `task_occurrences`, `citations`) keep their text, since review history shows it.
- `editor_events` is a cursor journal; cap it at a count and let old windows reseed from the head, which they already do for gaps over 500.

Run from the same prune step that drops patches. Cost: a few days plus a decision on defaults. This closes the domain model's open question.

### P5. A reader connection beside the writer

Addresses R5. Open one or more read-only connections in WAL mode for page reads, queries, search, agent context and sync's read steps. The writer keeps the mutex. Receipts and change events still come from the writer, so a client never sees a read older than its own acknowledgment if the service orders them, which the current cursor scheme already does. Cost: a day or two in `tessera-service`, none in the core. Risk: a read may lag a commit by the WAL frame boundary; the editor already tolerates that through revision checks.

### P6. Indexed field readings

Addresses R6. Add a derived table, class Indexed, that stores each value block's reading under its field's current kind:

```sql
CREATE TABLE field_readings (
    value_id TEXT PRIMARY KEY REFERENCES blocks(id),
    field_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    sort_key TEXT,        -- padded year, zero-padded number, casefolded text, or NULL for a problem
    number REAL,
    target_id TEXT        -- for relation, choice and instance readings
) STRICT;
CREATE INDEX field_readings_sort ON field_readings(field_id, sort_key, owner_id);
CREATE INDEX field_readings_target ON field_readings(field_id, target_id);
```

It is rebuilt when a value, its field's kind or its definition changes, in the same transaction as `field_values` today. Equality, range and relation filters and the first sort key then run in SQL with the limit, and only the remaining predicates run in Rust. The design rule "the index stores no copies of text" bends to "the index stores a derived sort key that P1 can recompute". Cost: about a week, with the bench harness proving the 42,000-member table under 100 ms. This is the one proposal that moves a budget.

### P7. One parser, compiled twice

Addresses R4. Export `link_tokens`, `tag_tokens`, `parse_card_text` and the field shorthand matcher from `tessera-core` through the existing wasm crate, and have `text-tokens.ts`, `card-text.ts` and `query.ts` call them. Move `Name:: value` conversion into the core's write path so API and agent writes convert the same way the browser does. Keep the TypeScript implementations only as a fallback behind a feature flag until the wasm path has run for a release. Cost: a week; the build already exists.

### P8. Version the JSON columns

Addresses R9. Add a `v` field to each JSON state shape with a serde default of 1, and a `json_version` table listing the current version per column so `tessera check` can report rows behind it. Migrations that reshape a JSON column become a loop over rows with a documented upgrade function, as `migrate_instance_filters` already is in all but name. Cost: a day.

### P9. Strict tables everywhere

Addresses R7. One migration rebuilds the non-STRICT tables with `STRICT`, preserving rowids where FTS depends on them (`passages`). Add a test that every table in `replication::TABLES` is STRICT, so the next migration cannot regress. Cost: half a day.

## What not to copy

- **Tana's parent-owned child arrays.** Every insert rewrites the parent; Tessera's sparse ordinals make an insert one row.
- **Logseq DB's fractional-index strings.** They avoid rebalancing but grow without bound under repeated insertion at one point, and they sort as text. Tessera's integer midpoint with a rare rebalance is simpler to reason about and the rebalance is already deterministic inside apply.
- **Logseq OG's text as the whole truth.** Tessera already keeps capability state out of wording. Extending text parsing to anything else would undo that.
- **Cloud-authoritative sync.** Tana's model needs a server to resolve every write. Tessera's hub can become a blind sequencer only because resolution is deterministic on every device; keep it that way.
- **Views as blocks.** Tana makes views nodes. Tessera's views are revisioned resources outside the outline, which keeps the block table about authored text and spares the editor from rendering query JSON.

## Suggested order

1. P1 and P9 together, since P9's migration is the first thing P1 should verify.
2. P5, which is service-only and relieves the worst latency risk.
3. P6, measured against the bench.
4. P4, after a decision on retention defaults.
5. P2, once P1's hashes exist.
6. P3 and P7, which touch authored text and the editor and deserve a release of their own.
7. P8 whenever the next JSON shape changes.

## Sources

Tana:

- [Intro to nodes, fields and supertags](https://tana.inc/articles/intro-to-nodes-fields-and-supertags)
- [Supertags](https://tana.inc/docs/supertags)
- [Fields](https://www.tana.inc/docs/fields)
- [Input API](https://outliner.tana.inc/learn/features/input-api)
- [Tana Desktop now works offline](https://tana.inc/articles/tana-desktop-now-works-offline-your-knowledge-graph-anywhere)
- [Offline access in Tana, community summary](https://productivematters.substack.com/p/offline-access-in-tana-what-the-latest)

Logseq:

- [Why the database version and how it's going](https://discuss.logseq.com/t/why-the-database-version-and-how-its-going/26744)
- [Logseq DB changelog](https://discuss.logseq.com/t/logseq-db-changelog/30013/31)
- [Changelog 2026-01-13 to 2026-03-23](https://discuss.logseq.com/t/logseq-db-changelog/30013/35)
- [Syncing Logseq DB](https://discuss.logseq.com/t/syncing-logseq-db/31285)
- [Logseq DB unofficial FAQ](https://logseq.io/page/e87c7359-51f7-44fe-87b3-4a0cd9f2dee3/695feeec-88be-4c5b-8bf2-572513c2f730)
- [Datascript fork](https://github.com/logseq/datascript)

Details of Logseq DB's `:block/order` key and of Tana's tuple nodes come from the author's reading of their source and export formats and were not confirmed by a public document during this audit.
