-- Membership identity follows the page, never its mutable title.
ALTER TABLE memberships RENAME TO memberships_old;
DROP INDEX memberships_type;
DROP INDEX memberships_title;
CREATE TABLE memberships (
    block_id TEXT NOT NULL REFERENCES blocks(id),
    type_id TEXT NOT NULL REFERENCES blocks(id),
    manual INTEGER NOT NULL CHECK (manual IN (0, 1)),
    title TEXT NOT NULL,
    PRIMARY KEY (block_id, type_id, manual)
) STRICT;
INSERT INTO memberships(block_id, type_id, manual, title)
SELECT block_id, type_id, manual, min(title) FROM memberships_old
WHERE type_id IS NOT NULL GROUP BY block_id, type_id, manual;
DROP TABLE memberships_old;
CREATE INDEX memberships_type ON memberships(type_id, block_id);
