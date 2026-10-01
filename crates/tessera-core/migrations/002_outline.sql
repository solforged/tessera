CREATE TABLE changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    idempotency_key TEXT UNIQUE,
    operations_hash TEXT NOT NULL,
    operations TEXT NOT NULL,
    committed TEXT NOT NULL
) STRICT;

CREATE TABLE deletion_events (
    id TEXT PRIMARY KEY,
    change_seq INTEGER NOT NULL REFERENCES changes(seq),
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE blocks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('block', 'page', 'journal')),
    parent_id TEXT REFERENCES blocks(id),
    page_id TEXT NOT NULL REFERENCES blocks(id),
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    title_key TEXT,
    heading INTEGER CHECK (heading BETWEEN 1 AND 3),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision > 0),
    deletion_id TEXT REFERENCES deletion_events(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind = 'block' AND parent_id IS NOT NULL AND title_key IS NULL)
        OR (kind = 'page' AND parent_id IS NULL AND page_id = id AND title_key IS NOT NULL)
        OR (kind = 'journal' AND parent_id IS NULL AND page_id = id AND title_key IS NULL))
) STRICT;

CREATE INDEX blocks_siblings ON blocks(parent_id, ordinal, id);
CREATE INDEX blocks_live_siblings ON blocks(parent_id, ordinal, id) WHERE deletion_id IS NULL;
CREATE INDEX blocks_live_page ON blocks(page_id, parent_id, ordinal, id) WHERE deletion_id IS NULL;
CREATE UNIQUE INDEX blocks_live_title ON blocks(title_key) WHERE kind = 'page' AND deletion_id IS NULL;
CREATE UNIQUE INDEX blocks_live_journal ON blocks(text) WHERE kind = 'journal' AND deletion_id IS NULL;

CREATE TABLE change_revisions (
    change_seq INTEGER NOT NULL REFERENCES changes(seq),
    position INTEGER NOT NULL,
    block_id TEXT NOT NULL REFERENCES blocks(id),
    revision INTEGER NOT NULL,
    PRIMARY KEY (change_seq, position),
    UNIQUE (change_seq, block_id)
) STRICT;

-- The target deliberately has no foreign key: references can be unresolved.
CREATE TABLE links (
    source_id TEXT NOT NULL REFERENCES blocks(id),
    occurrence INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    alias TEXT,
    PRIMARY KEY (source_id, occurrence)
) STRICT;
CREATE INDEX links_target ON links(target_id, source_id);

-- Rank candidates without fetching large authored records before the limit.
CREATE TABLE search_blocks (
    rowid INTEGER PRIMARY KEY,
    block_id TEXT NOT NULL UNIQUE REFERENCES blocks(id)
) STRICT;

CREATE VIRTUAL TABLE blocks_fts USING fts5(
    text, content = 'blocks', content_rowid = 'rowid',
    tokenize = 'unicode61', prefix = '2 3 4'
);
CREATE TRIGGER blocks_fts_insert AFTER INSERT ON blocks WHEN new.deletion_id IS NULL BEGIN
    INSERT INTO blocks_fts(rowid, text) VALUES (new.rowid, new.text);
    INSERT INTO search_blocks(rowid, block_id) VALUES (new.rowid, new.id);
END;
CREATE TRIGGER blocks_fts_update AFTER UPDATE OF text, deletion_id ON blocks
WHEN old.text != new.text OR (old.deletion_id IS NULL) != (new.deletion_id IS NULL) BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text)
        SELECT 'delete', old.rowid, old.text WHERE old.deletion_id IS NULL;
    INSERT INTO blocks_fts(rowid, text)
        SELECT new.rowid, new.text WHERE new.deletion_id IS NULL;
END;
CREATE TRIGGER blocks_search_state AFTER UPDATE OF deletion_id ON blocks
WHEN (old.deletion_id IS NULL) != (new.deletion_id IS NULL) BEGIN
    DELETE FROM search_blocks WHERE rowid = old.rowid;
    INSERT INTO search_blocks(rowid, block_id)
        SELECT new.rowid, new.id WHERE new.deletion_id IS NULL;
END;
