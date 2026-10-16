-- Keep existing page IDs and authored spellings, including legacy canonical
-- collisions. Future inserts and identity changes must not add another match.
DROP INDEX blocks_live_title;
UPDATE blocks SET title_key = tessera_title_key(text) WHERE kind = 'page';
CREATE INDEX blocks_live_title ON blocks(title_key) WHERE kind = 'page' AND deletion_id IS NULL;

-- Authored spellings retain separate legacy memberships and their target IDs
-- even when their new identity keys coincide. New derivation deduplicates keys.
ALTER TABLE memberships RENAME TO memberships_old;
DROP INDEX memberships_type;
DROP INDEX memberships_title;
CREATE TABLE memberships (
    block_id TEXT NOT NULL REFERENCES blocks(id),
    title_key TEXT NOT NULL,
    type_id TEXT REFERENCES blocks(id),
    manual INTEGER NOT NULL CHECK (manual IN (0, 1)),
    title TEXT NOT NULL,
    PRIMARY KEY (block_id, title, manual)
) STRICT;
INSERT INTO memberships(block_id, title_key, type_id, manual, title)
SELECT block_id, tessera_title_key(title), type_id, manual, title FROM memberships_old;
DROP TABLE memberships_old;
CREATE INDEX memberships_type ON memberships(type_id, block_id);
CREATE INDEX memberships_title ON memberships(title_key, block_id);

CREATE TRIGGER blocks_title_insert BEFORE INSERT ON blocks
WHEN new.kind = 'page' AND new.deletion_id IS NULL AND EXISTS (
    SELECT 1 FROM blocks WHERE kind = 'page' AND deletion_id IS NULL AND title_key = new.title_key
) BEGIN
    SELECT RAISE(ABORT, 'page title already exists');
END;
CREATE TRIGGER blocks_title_update BEFORE UPDATE OF title_key, deletion_id ON blocks
WHEN new.kind = 'page' AND new.deletion_id IS NULL
  AND (new.title_key IS NOT old.title_key OR old.deletion_id IS NOT NULL)
  AND EXISTS (
    SELECT 1 FROM blocks WHERE kind = 'page' AND deletion_id IS NULL
      AND title_key = new.title_key AND id <> new.id
) BEGIN
    SELECT RAISE(ABORT, 'page title already exists');
END;
