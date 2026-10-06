CREATE TABLE positions (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    active INTEGER NOT NULL CHECK (active IN (0, 1))
) STRICT;
