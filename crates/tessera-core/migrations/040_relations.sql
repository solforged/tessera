CREATE TABLE relations (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    kind TEXT NOT NULL CHECK (kind IN ('supports', 'disputes', 'qualifies', 'answers'))
) STRICT;
