//! A browser killed mid-save can leave a hot rollback journal in the OPFS pool.
//! Reopening must roll it back instead of reading the half-written pages.
#![cfg(all(target_arch = "wasm32", target_os = "unknown"))]

use rusqlite::{Connection, OpenFlags};
use sqlite_wasm_vfs::sahpool::{OpfsSAHPoolCfgBuilder, install};
use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

wasm_bindgen_test_configure!(run_in_dedicated_worker);

const VFS: &str = "tessera-hot-journal-test";
const DB: &str = "/hot/notebook.db";
const JOURNAL: &str = "/hot/notebook.db-journal";
const COMMITTED: i64 = 50;

fn open() -> Connection {
    Connection::open_with_flags_and_vfs(
        DB,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        VFS,
    )
    .unwrap()
}

#[wasm_bindgen_test]
async fn reopening_rolls_back_a_hot_journal() {
    let pool = install::<sqlite_wasm_rs::WasmOsCallback>(
        &OpfsSAHPoolCfgBuilder::new()
            .vfs_name(VFS)
            .directory(".tessera-hot-journal-test")
            .clear_on_init(true)
            .build(),
        false,
    )
    .await
    .unwrap();

    let conn = open();
    conn.execute_batch("CREATE TABLE rows (id INTEGER PRIMARY KEY, body BLOB NOT NULL);")
        .unwrap();
    for id in 0..COMMITTED {
        conn.execute(
            "INSERT INTO rows (id, body) VALUES (?1, zeroblob(4000))",
            [id],
        )
        .unwrap();
    }
    let committed = pool.export_db(DB).unwrap();

    // A cache smaller than the transaction makes SQLite sync the journal and spill
    // uncommitted pages into the database file: the state a kill can leave behind.
    conn.execute_batch(
        "PRAGMA cache_size = 10;
         BEGIN;
         UPDATE rows SET body = randomblob(4000);
         INSERT INTO rows (body) SELECT randomblob(4000) FROM rows;",
    )
    .unwrap();
    let torn = pool.export_db(DB).unwrap();
    let journal = pool.export_db(JOURNAL).unwrap();
    assert_ne!(
        torn, committed,
        "the transaction never reached the database file"
    );
    drop(conn);

    pool.delete_db(DB).unwrap();
    pool.delete_db(JOURNAL).unwrap();
    pool.import_db_unchecked(DB, &torn).unwrap();
    pool.import_db_unchecked(JOURNAL, &journal).unwrap();

    let conn = open();
    let check: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(check, "ok");
    let (rows, rewritten): (i64, i64) = conn
        .query_row(
            "SELECT count(*), count(*) FILTER (WHERE body <> zeroblob(4000)) FROM rows",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((rows, rewritten), (COMMITTED, 0));
    assert!(
        !pool.exists(JOURNAL).unwrap(),
        "the hot journal was not rolled back"
    );
}
