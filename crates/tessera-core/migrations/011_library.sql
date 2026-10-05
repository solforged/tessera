CREATE TABLE snapshots (
    id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, format TEXT NOT NULL,
    media_type TEXT NOT NULL, metadata TEXT NOT NULL, toc TEXT NOT NULL,
    passage_count INTEGER NOT NULL, text_length INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE passages (
    rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id), ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL, level INTEGER, text TEXT NOT NULL, locator TEXT NOT NULL,
    anchor TEXT, resource TEXT, marks TEXT NOT NULL, start INTEGER NOT NULL,
    UNIQUE(snapshot_id, ordinal), UNIQUE(snapshot_id, locator)
);
CREATE VIRTUAL TABLE passages_fts USING fts5(text, content='passages', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER passages_insert AFTER INSERT ON passages BEGIN
    INSERT INTO passages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TABLE snapshot_resources (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id), href TEXT NOT NULL,
    sha256 TEXT NOT NULL, media_type TEXT NOT NULL, PRIMARY KEY(snapshot_id, href)
);
CREATE TABLE sources (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id), active INTEGER NOT NULL,
    format TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('inbox','reading','finished','abandoned')),
    origin TEXT, match_key TEXT, citation_key TEXT, added_at INTEGER NOT NULL,
    state_changed_at INTEGER NOT NULL, last_read_at INTEGER
);
CREATE UNIQUE INDEX source_citation_key ON sources(citation_key COLLATE NOCASE) WHERE citation_key IS NOT NULL AND active = 1;
CREATE INDEX source_match_key ON sources(match_key);
CREATE TABLE source_snapshots (
    source_id TEXT NOT NULL REFERENCES sources(block_id), snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
    attached_at INTEGER NOT NULL, change_seq INTEGER NOT NULL REFERENCES changes(seq),
    PRIMARY KEY(source_id, snapshot_id)
);
CREATE INDEX snapshot_sources ON source_snapshots(snapshot_id, attached_at, change_seq);
CREATE TABLE reading_positions (
    snapshot_id TEXT PRIMARY KEY REFERENCES snapshots(id), passage_ordinal INTEGER NOT NULL,
    covered TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE citations (
    id TEXT PRIMARY KEY, block_id TEXT NOT NULL REFERENCES blocks(id), active INTEGER NOT NULL,
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id), start_passage TEXT NOT NULL REFERENCES passages(id),
    start_offset INTEGER NOT NULL, end_passage TEXT NOT NULL REFERENCES passages(id),
    end_offset INTEGER NOT NULL, created_seq INTEGER NOT NULL REFERENCES changes(seq)
);
CREATE INDEX block_citations ON citations(block_id);
CREATE INDEX snapshot_citations ON citations(snapshot_id);
CREATE TABLE ingest_jobs (
    id TEXT PRIMARY KEY, input_kind TEXT NOT NULL CHECK(input_kind IN ('url','file')),
    input TEXT NOT NULL, name TEXT NOT NULL, target_source TEXT,
    state TEXT NOT NULL CHECK(state IN ('queued','running','failed','done')),
    attempts INTEGER NOT NULL, error TEXT, next_attempt_at INTEGER,
    source_id TEXT, snapshot_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX queued_ingest_jobs ON ingest_jobs(state, next_attempt_at, created_at);
