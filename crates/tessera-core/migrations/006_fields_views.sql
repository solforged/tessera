CREATE TABLE fields (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'number', 'date', 'checkbox', 'choice', 'instance'))
) STRICT;

CREATE TABLE type_fields (
    type_id TEXT NOT NULL REFERENCES blocks(id),
    field_id TEXT NOT NULL REFERENCES blocks(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (type_id, field_id)
) STRICT;
CREATE INDEX type_fields_position ON type_fields(type_id, position);

CREATE TABLE views (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE field_values (
    owner_id TEXT NOT NULL REFERENCES blocks(id),
    field_id TEXT NOT NULL REFERENCES blocks(id),
    entry_id TEXT NOT NULL REFERENCES blocks(id),
    value_id TEXT NOT NULL REFERENCES blocks(id),
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (entry_id, value_id)
) STRICT;
CREATE INDEX field_values_owner ON field_values(owner_id, field_id);
CREATE INDEX field_values_field ON field_values(field_id);

-- Receipts include view IDs as well as block IDs. History survives view deletion.
ALTER TABLE change_revisions RENAME TO old_change_revisions;
CREATE TABLE change_revisions (
    change_seq INTEGER NOT NULL REFERENCES changes(seq),
    position INTEGER NOT NULL,
    block_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (change_seq, position),
    UNIQUE (change_seq, block_id)
) STRICT;
INSERT INTO change_revisions SELECT * FROM old_change_revisions;
DROP TABLE old_change_revisions;
ALTER TABLE changes ADD COLUMN views TEXT NOT NULL DEFAULT '[]';

-- The migration runner creates the Fields page with a canonical ULID and
-- rebuilds field_values using the same reference recognition as live writes.
