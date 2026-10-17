-- Every table is STRICT: the library tables from 011, the surfacings from
-- 015, the editor cursor journal from 028 and the card templates, type
-- presentation and field targets from 030 to 033 were not, so type affinity
-- could store text in their integer columns. Rebuild each with its rows and rowids;
-- passages_fts indexes passages by rowid, and the sync rows sort by their own
-- sequence columns. Children are built against the new parents and dropped
-- before them, so no foreign key is ever violated.
CREATE TABLE snapshots_strict (
    id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, format TEXT NOT NULL,
    media_type TEXT NOT NULL, metadata TEXT NOT NULL, toc TEXT NOT NULL,
    passage_count INTEGER NOT NULL, text_length INTEGER NOT NULL, created_at INTEGER NOT NULL
) STRICT;
INSERT INTO snapshots_strict(rowid, id, sha256, format, media_type, metadata, toc, passage_count, text_length, created_at)
    SELECT rowid, id, sha256, format, media_type, metadata, toc, passage_count, text_length, created_at FROM snapshots;

CREATE TABLE passages_strict (
    rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
    snapshot_id TEXT NOT NULL REFERENCES snapshots_strict(id), ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL, level INTEGER, text TEXT NOT NULL, locator TEXT NOT NULL,
    anchor TEXT, resource TEXT, marks TEXT NOT NULL, start INTEGER NOT NULL,
    UNIQUE(snapshot_id, ordinal), UNIQUE(snapshot_id, locator)
) STRICT;
INSERT INTO passages_strict(rowid, id, snapshot_id, ordinal, kind, level, text, locator, anchor, resource, marks, start)
    SELECT rowid, id, snapshot_id, ordinal, kind, level, text, locator, anchor, resource, marks, start FROM passages;

CREATE TABLE snapshot_resources_strict (
    snapshot_id TEXT NOT NULL REFERENCES snapshots_strict(id), href TEXT NOT NULL,
    sha256 TEXT NOT NULL, media_type TEXT NOT NULL, PRIMARY KEY(snapshot_id, href)
) STRICT;
INSERT INTO snapshot_resources_strict(rowid, snapshot_id, href, sha256, media_type)
    SELECT rowid, snapshot_id, href, sha256, media_type FROM snapshot_resources;

CREATE TABLE sources_strict (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id), active INTEGER NOT NULL,
    format TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('inbox','reading','finished','abandoned')),
    origin TEXT, match_key TEXT, citation_key TEXT, added_at INTEGER NOT NULL,
    state_changed_at INTEGER NOT NULL, last_read_at INTEGER
) STRICT;
INSERT INTO sources_strict(rowid, block_id, active, format, state, origin, match_key, citation_key, added_at, state_changed_at, last_read_at)
    SELECT rowid, block_id, active, format, state, origin, match_key, citation_key, added_at, state_changed_at, last_read_at FROM sources;

CREATE TABLE source_snapshots_strict (
    source_id TEXT NOT NULL REFERENCES sources_strict(block_id), snapshot_id TEXT NOT NULL REFERENCES snapshots_strict(id),
    attached_at INTEGER NOT NULL, change_seq INTEGER NOT NULL REFERENCES changes(seq),
    PRIMARY KEY(source_id, snapshot_id)
) STRICT;
INSERT INTO source_snapshots_strict(rowid, source_id, snapshot_id, attached_at, change_seq)
    SELECT rowid, source_id, snapshot_id, attached_at, change_seq FROM source_snapshots;

CREATE TABLE reading_positions_strict (
    snapshot_id TEXT PRIMARY KEY REFERENCES snapshots_strict(id), passage_ordinal INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    hlc INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '', sync_seq INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO reading_positions_strict(rowid, snapshot_id, passage_ordinal, updated_at, hlc, device, sync_seq)
    SELECT rowid, snapshot_id, passage_ordinal, updated_at, hlc, device, sync_seq FROM reading_positions;

CREATE TABLE citations_strict (
    id TEXT PRIMARY KEY, block_id TEXT NOT NULL REFERENCES blocks(id), active INTEGER NOT NULL,
    snapshot_id TEXT NOT NULL REFERENCES snapshots_strict(id), start_passage TEXT NOT NULL REFERENCES passages_strict(id),
    start_offset INTEGER NOT NULL, end_passage TEXT NOT NULL REFERENCES passages_strict(id),
    end_offset INTEGER NOT NULL, created_seq INTEGER NOT NULL REFERENCES changes(seq),
    triage TEXT CHECK (triage IN ('processed','unprocessed')),
    color TEXT CHECK (color IN ('yellow','green','blue','red','purple')),
    resurface_muted_at INTEGER
) STRICT;
INSERT INTO citations_strict(rowid, id, block_id, active, snapshot_id, start_passage, start_offset, end_passage, end_offset, created_seq, triage, color, resurface_muted_at)
    SELECT rowid, id, block_id, active, snapshot_id, start_passage, start_offset, end_passage, end_offset, created_seq, triage, color, resurface_muted_at FROM citations;

CREATE TABLE ingest_jobs_strict (
    id TEXT PRIMARY KEY, input_kind TEXT NOT NULL CHECK(input_kind IN ('url','file')),
    input TEXT NOT NULL, name TEXT NOT NULL, target_source TEXT,
    state TEXT NOT NULL CHECK(state IN ('queued','running','failed','done')),
    attempts INTEGER NOT NULL, error TEXT, next_attempt_at INTEGER,
    source_id TEXT, snapshot_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO ingest_jobs_strict(rowid, id, input_kind, input, name, target_source, state, attempts, error, next_attempt_at, source_id, snapshot_id, created_at, updated_at)
    SELECT rowid, id, input_kind, input, name, target_source, state, attempts, error, next_attempt_at, source_id, snapshot_id, created_at, updated_at FROM ingest_jobs;

CREATE TABLE highlight_surfacings_strict (
    citation_id TEXT NOT NULL REFERENCES citations_strict(id), date TEXT NOT NULL,
    shown_at INTEGER NOT NULL, action TEXT CHECK (action IN ('kept','opened','muted')),
    acted_at INTEGER,
    hlc INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '', sync_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (citation_id, date)
) STRICT;
INSERT INTO highlight_surfacings_strict(rowid, citation_id, date, shown_at, action, acted_at, hlc, device, sync_seq)
    SELECT rowid, citation_id, date, shown_at, action, acted_at, hlc, device, sync_seq FROM highlight_surfacings;

CREATE TABLE editor_events_strict (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id TEXT,
    actor TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    committed TEXT NOT NULL,
    restructured_pages TEXT NOT NULL,
    views TEXT NOT NULL
) STRICT;
INSERT INTO editor_events_strict(seq, change_id, actor, reason, created_at, committed, restructured_pages, views)
    SELECT seq, change_id, actor, reason, created_at, committed, restructured_pages, views FROM editor_events;
-- Windows hold cursors into this journal: keep its high-water mark even when
-- the journal is empty, as the rename below carries the row along.
DELETE FROM sqlite_sequence WHERE name = 'editor_events_strict';
INSERT INTO sqlite_sequence(name, seq) SELECT 'editor_events_strict', seq FROM sqlite_sequence WHERE name = 'editor_events';

CREATE TABLE card_templates_strict (
    id TEXT PRIMARY KEY,
    type_id TEXT NOT NULL REFERENCES blocks(id),
    name TEXT NOT NULL,
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    position INTEGER NOT NULL,
    applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
    new_per_day INTEGER NOT NULL CHECK (new_per_day BETWEEN 1 AND 9999),
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO card_templates_strict(rowid, id, type_id, name, front, back, position, applied, new_per_day, revision, created_at, updated_at)
    SELECT rowid, id, type_id, name, front, back, position, applied, new_per_day, revision, created_at, updated_at FROM card_templates;

CREATE TABLE type_presentation_strict (
    type_id TEXT PRIMARY KEY REFERENCES blocks(id),
    plural TEXT,
    icon TEXT
) STRICT;
INSERT INTO type_presentation_strict(rowid, type_id, plural, icon)
    SELECT rowid, type_id, plural, icon FROM type_presentation;

CREATE TABLE field_targets_strict (
    field_id TEXT NOT NULL REFERENCES blocks(id),
    type_id TEXT NOT NULL REFERENCES blocks(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (field_id, type_id)
) STRICT;
INSERT INTO field_targets_strict(rowid, field_id, type_id, position)
    SELECT rowid, field_id, type_id, position FROM field_targets;

DROP TABLE highlight_surfacings;
DROP TABLE citations;
DROP TABLE source_snapshots;
DROP TABLE reading_positions;
DROP TABLE snapshot_resources;
DROP TABLE passages;
DROP TABLE sources;
DROP TABLE snapshots;
DROP TABLE ingest_jobs;
DROP TABLE editor_events;
DROP TABLE card_templates;
DROP TABLE type_presentation;
DROP TABLE field_targets;

ALTER TABLE snapshots_strict RENAME TO snapshots;
ALTER TABLE passages_strict RENAME TO passages;
ALTER TABLE snapshot_resources_strict RENAME TO snapshot_resources;
ALTER TABLE sources_strict RENAME TO sources;
ALTER TABLE source_snapshots_strict RENAME TO source_snapshots;
ALTER TABLE reading_positions_strict RENAME TO reading_positions;
ALTER TABLE citations_strict RENAME TO citations;
ALTER TABLE ingest_jobs_strict RENAME TO ingest_jobs;
ALTER TABLE highlight_surfacings_strict RENAME TO highlight_surfacings;
ALTER TABLE editor_events_strict RENAME TO editor_events;
ALTER TABLE card_templates_strict RENAME TO card_templates;
ALTER TABLE type_presentation_strict RENAME TO type_presentation;
ALTER TABLE field_targets_strict RENAME TO field_targets;

CREATE TRIGGER passages_insert AFTER INSERT ON passages BEGIN
    INSERT INTO passages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE UNIQUE INDEX source_citation_key ON sources(citation_key COLLATE NOCASE) WHERE citation_key IS NOT NULL AND active = 1;
CREATE INDEX source_match_key ON sources(match_key);
CREATE INDEX snapshot_sources ON source_snapshots(snapshot_id, attached_at, change_seq);
CREATE INDEX reading_positions_sync ON reading_positions(sync_seq);
CREATE INDEX block_citations ON citations(block_id);
CREATE INDEX snapshot_citations ON citations(snapshot_id);
CREATE INDEX queued_ingest_jobs ON ingest_jobs(state, next_attempt_at, created_at);
CREATE INDEX ingest_jobs_target ON ingest_jobs(target_source) WHERE target_source IS NOT NULL;
CREATE INDEX surfacings_by_date ON highlight_surfacings(date);
CREATE INDEX highlight_surfacings_sync ON highlight_surfacings(sync_seq);
CREATE INDEX editor_events_change ON editor_events(change_id, seq);
CREATE INDEX card_templates_type ON card_templates(type_id, position);
CREATE INDEX field_targets_type ON field_targets(type_id);
