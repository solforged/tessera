CREATE TABLE quotes (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    target_id TEXT NOT NULL,
    state TEXT NOT NULL
) STRICT;

CREATE INDEX quotes_target ON quotes(target_id);
