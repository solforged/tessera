use rusqlite::Connection;

/// A downgrade fixture must restore the search schema as well as its version.
/// Reuse released SQL so it exercises the real upgrade, not a hybrid schema.
pub fn restore_authored_search(conn: &Connection) {
    conn.execute_batch(
        "DROP TRIGGER search_text_insert;
         DROP TRIGGER search_text_update;
         DROP TRIGGER search_text_delete;
         DROP TRIGGER blocks_search_insert;
         DROP TRIGGER blocks_search_update;
         DROP TRIGGER blocks_search_delete;
         DROP TRIGGER links_search_insert;
         DROP TRIGGER links_search_delete;
         DROP TRIGGER links_search_update;
         DROP VIEW block_search_text;
         DROP TABLE blocks_fts;
         DROP TABLE search_blocks;",
    )
    .unwrap();
    let outline = include_str!("../../migrations/002_outline.sql");
    conn.execute_batch(&outline[outline.find("CREATE TABLE search_blocks").unwrap()..])
        .unwrap();
    conn.execute_batch(
        "INSERT INTO search_blocks(rowid, block_id) SELECT rowid, id FROM blocks WHERE deletion_id IS NULL;
         INSERT INTO blocks_fts(rowid, text) SELECT rowid, text FROM blocks WHERE deletion_id IS NULL;",
    )
    .unwrap();
    let sync = include_str!("../../migrations/023_sync.sql");
    let start = sync.find("CREATE TRIGGER blocks_search_delete").unwrap();
    let end = start + sync[start..].find("END;").unwrap() + 4;
    conn.execute_batch(&sync[start..end]).unwrap();
}

/// Before schema 40, authored argument edges had no capability table.
pub fn restore_pre_relations(conn: &Connection) {
    restore_pre_images(conn);
    conn.execute_batch("ALTER TABLE fields DROP COLUMN role;")
        .unwrap();
    conn.execute_batch("DROP TABLE revisit_events; DROP TABLE note_states; DROP TABLE relations;")
        .unwrap();
}

/// Before schema 41, saved spreads had no capability table.
pub fn restore_pre_spreads(conn: &Connection) {
    conn.execute_batch("DROP TABLE spreads;").unwrap();
}

/// Before schema 48, image blocks had no retained capability table.
pub fn restore_pre_images(conn: &Connection) {
    restore_pre_occlusions(conn);
    conn.execute_batch("DROP TABLE images;").unwrap();
}

/// Before schema 49, image masks had no capability table.
pub fn restore_pre_occlusions(conn: &Connection) {
    restore_title_memberships(conn);
    conn.execute_batch("DROP TABLE occlusions;").unwrap();
    let migration = include_str!("../../migrations/049_occlusions.sql");
    let rebuild = &migration[migration.find("CREATE TABLE card_units_occlusion").unwrap()..];
    conn.execute_batch(&rebuild.replace(", 'occlusion'", ""))
        .unwrap();
}

/// Restore the last title-keyed membership schema for downgrade fixtures.
pub fn restore_title_memberships(conn: &Connection) {
    conn.execute_batch(
        "ALTER TABLE memberships RENAME TO id_memberships;
         DROP INDEX memberships_type;
         CREATE TABLE memberships (
             block_id TEXT NOT NULL REFERENCES blocks(id),
             title_key TEXT NOT NULL,
             type_id TEXT REFERENCES blocks(id),
             manual INTEGER NOT NULL CHECK (manual IN (0, 1)),
             title TEXT NOT NULL,
             PRIMARY KEY (block_id, title, manual)
         ) STRICT;
         INSERT INTO memberships SELECT m.block_id, p.title_key, m.type_id, m.manual, m.title
             FROM id_memberships m JOIN blocks p ON p.id = m.type_id;
         DROP TABLE id_memberships;
         CREATE INDEX memberships_type ON memberships(type_id, block_id);
         CREATE INDEX memberships_title ON memberships(title_key, block_id);",
    )
    .unwrap();
}
