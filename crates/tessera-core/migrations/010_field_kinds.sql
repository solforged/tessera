-- URL and identifier kinds. SQLite cannot widen a CHECK in place.
CREATE TABLE fields_new (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'number', 'date', 'checkbox', 'choice', 'instance', 'url', 'identifier'))
) STRICT;
INSERT INTO fields_new SELECT block_id, kind FROM fields;
DROP TABLE fields;
ALTER TABLE fields_new RENAME TO fields;
