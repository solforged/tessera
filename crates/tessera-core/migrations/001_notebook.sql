-- Notebook identity. Exactly one row, written when the notebook is created.
CREATE TABLE notebook (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;
