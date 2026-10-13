-- Search remains derived: authored references never acquire copied labels.
DROP TRIGGER blocks_fts_insert;
DROP TRIGGER blocks_fts_update;
DROP TRIGGER blocks_search_state;
DROP TRIGGER blocks_search_delete;
DROP TABLE blocks_fts;
ALTER TABLE search_blocks ADD COLUMN text TEXT NOT NULL DEFAULT '';

CREATE VIEW block_search_text AS
SELECT b.rowid AS rowid, b.id AS block_id,
       b.text || COALESCE((
           SELECT ' ' || group_concat(t.text, ' ')
           FROM links l JOIN blocks t ON t.id = l.target_id
           WHERE l.source_id = b.id AND l.alias IS NULL AND t.deletion_id IS NULL
       ), '') AS text
FROM blocks b WHERE b.deletion_id IS NULL;

UPDATE search_blocks SET text = (
    SELECT text FROM block_search_text WHERE rowid = search_blocks.rowid
);
CREATE VIRTUAL TABLE blocks_fts USING fts5(
    text, content = 'search_blocks', content_rowid = 'rowid',
    tokenize = 'unicode61', prefix = '2 3 4'
);
INSERT INTO blocks_fts(blocks_fts) VALUES ('rebuild');

CREATE TRIGGER search_text_insert AFTER INSERT ON search_blocks BEGIN
    INSERT INTO blocks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER search_text_update AFTER UPDATE OF text ON search_blocks
WHEN old.text != new.text BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO blocks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER search_text_delete AFTER DELETE ON search_blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER blocks_search_insert AFTER INSERT ON blocks BEGIN
    INSERT INTO search_blocks(rowid, block_id, text)
        SELECT rowid, block_id, text FROM block_search_text WHERE block_id = new.id;
    UPDATE search_blocks SET text = (
        SELECT text FROM block_search_text WHERE rowid = search_blocks.rowid
    ) WHERE block_id IN (SELECT source_id FROM links WHERE target_id = new.id AND alias IS NULL);
END;
CREATE TRIGGER blocks_search_update AFTER UPDATE OF text, deletion_id ON blocks
WHEN old.text != new.text OR (old.deletion_id IS NULL) != (new.deletion_id IS NULL) BEGIN
    DELETE FROM search_blocks WHERE block_id = new.id AND new.deletion_id IS NOT NULL;
    INSERT INTO search_blocks(rowid, block_id, text)
        SELECT rowid, block_id, text FROM block_search_text WHERE block_id = new.id
        ON CONFLICT(block_id) DO UPDATE SET text = excluded.text;
    UPDATE search_blocks SET text = (
        SELECT text FROM block_search_text WHERE rowid = search_blocks.rowid
    ) WHERE block_id IN (SELECT source_id FROM links WHERE target_id = new.id AND alias IS NULL);
END;
CREATE TRIGGER blocks_search_delete AFTER DELETE ON blocks BEGIN
    DELETE FROM search_blocks WHERE block_id = old.id;
    UPDATE search_blocks SET text = (
        SELECT text FROM block_search_text WHERE rowid = search_blocks.rowid
    ) WHERE block_id IN (SELECT source_id FROM links WHERE target_id = old.id AND alias IS NULL);
END;

CREATE TRIGGER links_search_insert AFTER INSERT ON links WHEN new.alias IS NULL BEGIN
    UPDATE search_blocks SET text = (
        SELECT text FROM block_search_text WHERE rowid = search_blocks.rowid
    ) WHERE block_id = new.source_id;
END;
CREATE TRIGGER links_search_delete AFTER DELETE ON links WHEN old.alias IS NULL BEGIN
    UPDATE search_blocks SET text = (
        SELECT text FROM block_search_text WHERE rowid = search_blocks.rowid
    ) WHERE block_id = old.source_id;
END;
CREATE TRIGGER links_search_update AFTER UPDATE ON links
WHEN old.alias IS NULL OR new.alias IS NULL BEGIN
    UPDATE search_blocks SET text = (
        SELECT text FROM block_search_text WHERE rowid = search_blocks.rowid
    ) WHERE block_id IN (old.source_id, new.source_id);
END;
