-- Preserve membership sources and authored spelling independently.
ALTER TABLE memberships RENAME TO memberships_old;
DROP INDEX memberships_type;
DROP INDEX memberships_title;
CREATE TABLE memberships (
    block_id TEXT NOT NULL REFERENCES blocks(id),
    title_key TEXT NOT NULL,
    type_id TEXT REFERENCES blocks(id),
    manual INTEGER NOT NULL CHECK (manual IN (0, 1)),
    title TEXT NOT NULL,
    PRIMARY KEY (block_id, title_key, manual)
) STRICT;
INSERT INTO memberships(block_id, title_key, type_id, manual, title)
SELECT block_id, title_key, type_id, 0, title_key FROM memberships_old;
DROP TABLE memberships_old;
CREATE INDEX memberships_type ON memberships(type_id, block_id);
CREATE INDEX memberships_title ON memberships(title_key, block_id);
