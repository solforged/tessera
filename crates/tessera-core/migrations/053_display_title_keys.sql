-- migrate.rs first drops the old index/triggers and disambiguates live names.
-- Keys are derived from the same identity_name/title_key functions as writes.
UPDATE blocks SET title_key = tessera_title_key(text) WHERE kind = 'page';
CREATE INDEX blocks_live_title ON blocks(title_key) WHERE kind = 'page' AND deletion_id IS NULL;

-- Memberships have been ID-addressed since 051; there is no title key to rewrite.
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
