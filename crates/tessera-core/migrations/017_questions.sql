CREATE TABLE questions (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    state TEXT NOT NULL
) STRICT;

CREATE TABLE assessments (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    state TEXT NOT NULL
) STRICT;
