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
    conn.execute_batch("DROP TABLE relations;").unwrap();
}

/// Before schema 41, saved spreads had no capability table.
pub fn restore_pre_spreads(conn: &Connection) {
    conn.execute_batch("DROP TABLE spreads;").unwrap();
}
