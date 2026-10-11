-- Blocks are tombstoned, never deleted, except when a replica undoes its own
-- unconfirmed change; keep the search index consistent then too.
CREATE TRIGGER blocks_search_delete AFTER DELETE ON blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text)
        SELECT 'delete', old.rowid, old.text WHERE old.deletion_id IS NULL;
    DELETE FROM search_blocks WHERE rowid = old.rowid;
END;

-- Hub side. Replicas cloned from this notebook and how far each has pulled.
CREATE TABLE sync_replicas (
    device_id TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL,
    cloned_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
) STRICT;

-- The row-level effect of each change, as an SQLite session changeset. A hub
-- records them while it has replicas and drops those every replica has pulled.
CREATE TABLE change_patches (
    seq INTEGER PRIMARY KEY,
    patch BLOB NOT NULL
) STRICT;

-- Replica side. The hub this notebook was cloned from and the last hub change
-- applied here.
CREATE TABLE sync_hub (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    notebook_id TEXT NOT NULL,
    url TEXT NOT NULL,
    confirmed_seq INTEGER NOT NULL
) STRICT;

-- Local changes the hub has not confirmed, in the order they were made. `seq`
-- and `patch` describe the change's current local application; both are NULL
-- while it is not applied here.
CREATE TABLE sync_pending (
    change_id TEXT PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE,
    stamp TEXT NOT NULL,
    batch TEXT NOT NULL,
    bases TEXT NOT NULL,
    seq INTEGER,
    patch BLOB
) STRICT;

-- Replicated. IDs a device created that the hub resolved to an existing
-- record, such as a second page with the same title or a second journal day.
CREATE TABLE id_aliases (
    alias TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    change_seq INTEGER NOT NULL
) STRICT;

-- Replicated. Text kept beside a block when two devices edited it, and
-- changes the hub could not apply.
CREATE TABLE sync_conflicts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('copy', 'rejected')),
    change_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    block_id TEXT,
    text TEXT,
    batch TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    change_seq INTEGER NOT NULL
) STRICT;
CREATE INDEX sync_conflicts_copy ON sync_conflicts(origin, block_id) WHERE kind = 'copy';
