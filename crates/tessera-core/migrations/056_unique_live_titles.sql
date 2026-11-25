DROP TRIGGER IF EXISTS blocks_title_insert;
DROP TRIGGER IF EXISTS blocks_title_update;
DROP INDEX IF EXISTS blocks_live_title;
CREATE UNIQUE INDEX blocks_live_title ON blocks(title_key) WHERE kind = 'page' AND deletion_id IS NULL;
