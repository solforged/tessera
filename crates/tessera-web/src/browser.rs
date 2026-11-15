use std::{cell::RefCell, collections::HashMap};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, header::CONTENT_TYPE},
};
use futures_util::future::{AbortHandle, Abortable};
use js_sys::{Function, JsString, Uint8Array};
use rusqlite::{Connection, OpenFlags};
use sqlite_wasm_vfs::sahpool::{OpfsSAHError, OpfsSAHPoolCfg, OpfsSAHPoolUtil};
use tessera_api::EmbeddedHandles;
use tessera_core::{SCHEMA_VERSION, Workshop};
use tower::ServiceExt;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen(
    inline_js = "export function supports_opfs() { return globalThis.isSecureContext === true && typeof globalThis.navigator?.storage?.getDirectory === 'function' && typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle === 'function'; }"
)]
extern "C" {
    fn supports_opfs() -> bool;
}

const LIVE_DB: &str = "/demo/notebook.db";
const STAGED_DIR: &str = "/demo-restore";
const STAGED_DB: &str = "/demo-restore/notebook.db";
const UPGRADE_PREFIX: &str = "/demo-upgrade-";
const NOT_TESSERA: &str = "This file is not a Tessera backup.";
const NEWER_BACKUP: &str = "This backup comes from a newer version of Tessera than this page runs.";
const DAMAGED_BACKUP: &str = "This backup is damaged and cannot be restored.";
const EXTERNAL_BOOKS: &str =
    "This backup's books are stored outside it, so it cannot be restored here.";

struct App {
    router: Router,
    handles: EmbeddedHandles,
}

#[derive(Default)]
struct Runtime {
    pool: Option<OpfsSAHPoolUtil>,
    app: Option<App>,
    subscriptions: HashMap<u64, AbortHandle>,
    next_subscription: u64,
}

thread_local! {
    static RUNTIME: RefCell<Runtime> = RefCell::new(Runtime::default());
}

fn internal(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&format!("internal: {error}")).into()
}

fn pool_error(error: OpfsSAHError) -> JsValue {
    let code = match &error {
        OpfsSAHError::NotSupported | OpfsSAHError::GetDirHandle(_) => "unsupported",
        OpfsSAHError::CreateSyncAccessHandle(_) => "locked",
        _ => "internal",
    };
    js_sys::Error::new(&format!("{code}: {error}")).into()
}

fn with_app<T>(operation: impl FnOnce(&App) -> Result<T, JsValue>) -> Result<T, JsValue> {
    RUNTIME.with(|runtime| {
        let runtime = runtime.borrow();
        let app = runtime
            .app
            .as_ref()
            .ok_or_else(|| internal("The workshop is not open."))?;
        operation(app)
    })
}

fn with_pool<T>(
    operation: impl FnOnce(&OpfsSAHPoolUtil) -> Result<T, JsValue>,
) -> Result<T, JsValue> {
    RUNTIME.with(|runtime| {
        let runtime = runtime.borrow();
        operation(
            runtime
                .pool
                .as_ref()
                .ok_or_else(|| internal("The workshop is not open."))?,
        )
    })
}

fn close_app() {
    RUNTIME.with(|runtime| {
        let mut runtime = runtime.borrow_mut();
        for (_, abort) in runtime.subscriptions.drain() {
            abort.abort();
        }
        // Subscription tasks hold receivers, not workshop handles.
        runtime.app = None;
    });
}

/// Close the workshop and release its exclusive OPFS access handles.
/// The caller must finish outstanding requests before closing.
#[wasm_bindgen]
pub fn close() -> Result<(), JsValue> {
    close_app();
    RUNTIME.with(|runtime| {
        if let Some(pool) = &runtime.borrow().pool {
            pool.pause_vfs().map_err(pool_error)?;
        }
        Ok(())
    })
}

fn delete_workshop(pool: &OpfsSAHPoolUtil, database: &str) -> Result<(), JsValue> {
    for suffix in ["-journal", "-wal", "-shm", ""] {
        pool.delete_db(&format!("{database}{suffix}"))
            .map_err(pool_error)?;
    }
    Ok(())
}

fn invalid(message: &str) -> JsValue {
    js_sys::Error::new(&format!("invalid: {message}")).into()
}

fn invalid_sqlite(error: rusqlite::Error) -> JsValue {
    invalid(
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::NotADatabase) {
            NOT_TESSERA
        } else {
            DAMAGED_BACKUP
        },
    )
}

fn connection(database: &str) -> rusqlite::Result<Connection> {
    // Read-write permits hot-journal rollback, but never creates a missing file.
    Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)
}

fn schema_version(conn: &Connection) -> rusqlite::Result<u32> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
}

fn has_table(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
}

fn validate_staged() -> Result<(), JsValue> {
    {
        let conn = connection(STAGED_DB).map_err(invalid_sqlite)?;
        if schema_version(&conn).map_err(invalid_sqlite)? > SCHEMA_VERSION {
            return Err(invalid(NEWER_BACKUP));
        }
        let mut statement = conn
            .prepare("PRAGMA integrity_check")
            .map_err(invalid_sqlite)?;
        let mut rows = statement.query([]).map_err(invalid_sqlite)?;
        let mut checked = false;
        while let Some(row) = rows.next().map_err(invalid_sqlite)? {
            if row.get::<_, String>(0).map_err(invalid_sqlite)? != "ok" {
                return Err(invalid(DAMAGED_BACKUP));
            }
            checked = true;
        }
        if !checked {
            return Err(invalid(DAMAGED_BACKUP));
        }
        if !has_table(&conn, "notebook").map_err(invalid_sqlite)? {
            return Err(invalid(NOT_TESSERA));
        }
        let has_objects = has_table(&conn, "browser_objects").map_err(invalid_sqlite)?;
        // Sources refer to snapshots; both original bytes and extracted resources
        // must be embedded. Older workshops may predate the library tables.
        for table in ["snapshots", "snapshot_resources"] {
            if !has_table(&conn, table).map_err(invalid_sqlite)? {
                continue;
            }
            let sql = if has_objects {
                format!(
                    "SELECT EXISTS(SELECT 1 FROM {table} AS reference
                     WHERE NOT EXISTS(SELECT 1 FROM browser_objects AS object
                                      WHERE object.sha256 = reference.sha256))"
                )
            } else {
                format!("SELECT EXISTS(SELECT 1 FROM {table})")
            };
            let missing: bool = conn
                .query_row(&sql, [], |row| row.get(0))
                .map_err(invalid_sqlite)?;
            if missing {
                return Err(invalid(EXTERNAL_BOOKS));
            }
        }
    }
    // Migrate only the private staging workshop, never the current workshop.
    Workshop::open(STAGED_DIR)
        .and_then(|workshop| workshop.info())
        .map_err(|_| invalid(DAMAGED_BACKUP))?;
    Ok(())
}

fn flush_import(database: &str) -> Result<(), JsValue> {
    let conn = connection(database).map_err(internal)?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(internal)?;
    let version = schema_version(&conn).map_err(internal)?;
    // Pool imports do not flush. A header write commits and syncs the whole
    // database, including the pool's filename header, before its source is lost.
    conn.pragma_update(None, "user_version", version)
        .map_err(internal)
}

fn replace_with_staged() -> Result<(), JsValue> {
    flush_import(STAGED_DB)?;
    let bytes = with_pool(|pool| pool.export_db(STAGED_DB).map_err(pool_error))?;
    close_app();
    with_pool(|pool| {
        delete_workshop(pool, LIVE_DB)?;
        pool.import_db(LIVE_DB, &bytes).map_err(pool_error)?;
        flush_import(LIVE_DB)?;
        delete_workshop(pool, STAGED_DB)
    })
}

fn recover_restore() -> Result<(), JsValue> {
    if !with_pool(|pool| pool.exists(STAGED_DB).map_err(pool_error))? {
        return Ok(());
    }
    if validate_staged().is_err() {
        return with_pool(|pool| delete_workshop(pool, STAGED_DB));
    }
    replace_with_staged()
}

fn upgrade_file(pool: &OpfsSAHPoolUtil) -> Option<(String, u32, i64, usize)> {
    pool.list().into_iter().find_map(|filename| {
        let (version, metadata) = filename
            .strip_prefix(UPGRADE_PREFIX)?
            .strip_suffix(".db")?
            .split_once('-')?;
        let version = version.parse().ok()?;
        let (created_at, size) = metadata.split_once('-')?;
        let created_at = created_at.parse().ok()?;
        let size = size.parse().ok()?;
        Some((filename, version, created_at, size))
    })
}

fn save_upgrade_copy() -> Result<(), JsValue> {
    with_pool(|pool| {
        if !pool.exists(LIVE_DB).map_err(pool_error)? {
            return Ok(());
        }
        // Opening and reading may roll back a hot journal, but cannot migrate.
        let version = schema_version(&connection(LIVE_DB).map_err(internal)?).map_err(internal)?;
        if version == 0 || version >= SCHEMA_VERSION {
            return Ok(());
        }
        let bytes = pool.export_db(LIVE_DB).map_err(pool_error)?;
        if let Some((filename, _, _, _)) = upgrade_file(pool) {
            delete_workshop(pool, &filename)?;
        }
        let created_at = js_sys::Date::now() as i64;
        let filename = format!("{UPGRADE_PREFIX}{version}-{created_at}-{}.db", bytes.len());
        pool.import_db(&filename, &bytes).map_err(pool_error)?;
        flush_import(&filename)
    })
}

fn reopen() -> Result<String, JsValue> {
    let workshop = Workshop::open("/demo").map_err(internal)?;
    let info = serde_json::to_string(&workshop.info().map_err(internal)?).map_err(internal)?;
    let (router, handles) = tessera_api::embedded_router(workshop).map_err(internal)?;
    RUNTIME.with(|runtime| runtime.borrow_mut().app = Some(App { router, handles }));
    Ok(info)
}

/// Acquire this browser origin's exclusive OPFS pool and open its workshop.
#[wasm_bindgen]
pub async fn open() -> Result<String, JsValue> {
    if RUNTIME.with(|runtime| runtime.borrow().app.is_some()) {
        return with_app(|app| {
            serde_json::to_string(&app.handles.workshop.lock().info().map_err(internal)?)
                .map_err(internal)
        });
    }
    if !supports_opfs() {
        return Err(js_sys::Error::new(
            "unsupported: This browser does not provide OPFS synchronous access handles in a secure worker.",
        )
        .into());
    }
    if RUNTIME.with(|runtime| runtime.borrow().pool.is_none()) {
        let pool = sqlite_wasm_vfs::sahpool::install::<sqlite_wasm_rs::WasmOsCallback>(
            &OpfsSAHPoolCfg::default(),
            true,
        )
        .await
        .map_err(pool_error)?;
        // Live and staged databases can each need a journal; flushing the
        // upgrade copy can also need one.
        pool.reserve_minimum_capacity(6).await.map_err(pool_error)?;
        RUNTIME.with(|runtime| runtime.borrow_mut().pool = Some(pool));
    } else {
        let pool = RUNTIME.with(|runtime| runtime.borrow_mut().pool.take().unwrap());
        let result = pool.unpause_vfs().await.map_err(pool_error);
        RUNTIME.with(|runtime| runtime.borrow_mut().pool = Some(pool));
        result?;
    }
    recover_restore()?;
    save_upgrade_copy()?;
    reopen()
}

/// An empty workshop needs the demo's initial pages and journals.
#[wasm_bindgen]
pub fn is_empty() -> Result<bool, JsValue> {
    with_app(|app| {
        let workshop = app.handles.workshop.lock();
        // The Fields page is created by migrations, before any user/demo content.
        let fields_page = workshop.fields().map_err(internal)?.page_id;
        Ok(!workshop
            .roots()
            .map_err(internal)?
            .iter()
            .any(|root| root.id != fields_page))
    })
}

/// Export a complete, committed single-file browser workshop.
#[wasm_bindgen]
pub fn export_notebook() -> Result<Uint8Array, JsValue> {
    with_app(|app| {
        let _workshop = app.handles.workshop.lock();
        // Workshop methods finish their transactions before releasing this mutex.
        // The worker serializes requests and this synchronous export cannot yield.
        with_pool(|pool| {
            let bytes = pool.export_db(LIVE_DB).map_err(pool_error)?;
            Ok(Uint8Array::from(bytes.as_slice()))
        })
    })
}

/// Validate and migrate a private copy before replacing the open workshop.
#[wasm_bindgen]
pub async fn restore_notebook(bytes: Vec<u8>) -> Result<String, JsValue> {
    with_app(|_| Ok(()))?;
    with_pool(|pool| {
        delete_workshop(pool, STAGED_DB)?;
        let staged = pool
            .import_db(STAGED_DB, &bytes)
            .map_err(|error| match error {
                OpfsSAHError::ImportDb(_) => invalid(NOT_TESSERA),
                other => pool_error(other),
            })
            .and_then(|()| validate_staged());
        if let Err(error) = staged {
            delete_workshop(pool, STAGED_DB)?;
            return Err(error);
        }
        Ok(())
    })?;
    drop(bytes);
    replace_with_staged()?;
    reopen()
}

/// Describe the single workshop copy saved before a schema upgrade.
#[wasm_bindgen]
pub fn upgrade_copy() -> Result<Option<String>, JsValue> {
    with_pool(|pool| {
        let Some((_, schema_version, created_at, size)) = upgrade_file(pool) else {
            return Ok(None);
        };
        Ok(Some(
            serde_json::json!({
                "schema_version": schema_version,
                "created_at": created_at,
                "size": size,
            })
            .to_string(),
        ))
    })
}

/// Export the workshop copy saved before the last schema upgrade.
#[wasm_bindgen]
pub fn export_upgrade_copy() -> Result<Uint8Array, JsValue> {
    with_pool(|pool| {
        let (filename, _, _, _) =
            upgrade_file(pool).ok_or_else(|| internal("There is no upgrade copy."))?;
        let bytes = pool.export_db(&filename).map_err(pool_error)?;
        Ok(Uint8Array::from(bytes.as_slice()))
    })
}

/// Restore the upgrade copy through the same validation and staging path.
#[wasm_bindgen]
pub async fn restore_upgrade_copy() -> Result<String, JsValue> {
    let bytes = with_pool(|pool| {
        let (filename, _, _, _) =
            upgrade_file(pool).ok_or_else(|| internal("There is no upgrade copy."))?;
        pool.export_db(&filename).map_err(pool_error)
    })?;
    restore_notebook(bytes).await
}

/// A buffered HTTP response from the shared workshop router.
#[wasm_bindgen]
pub struct WebResponse {
    status: u16,
    content_type: JsString,
    body: Uint8Array,
}

#[wasm_bindgen]
impl WebResponse {
    #[wasm_bindgen(getter)]
    pub fn status(&self) -> u16 {
        self.status
    }

    #[wasm_bindgen(getter)]
    pub fn content_type(&self) -> JsString {
        self.content_type.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn body(&self) -> Uint8Array {
        self.body.clone()
    }
}

/// Dispatch an HTTP request to exactly the same workshop handlers as the service.
/// `headers` alternates names and values.
#[wasm_bindgen]
pub async fn handle(
    method: String,
    path: String,
    headers: Vec<String>,
    body: Vec<u8>,
) -> Result<WebResponse, JsValue> {
    let router = with_app(|app| Ok(app.router.clone()))?;
    let mut request = Request::builder().method(method.as_str()).uri(path);
    for [name, value] in headers.as_chunks::<2>().0 {
        request = request.header(name.as_str(), value.as_str());
    }
    let request = request.body(Body::from(body)).map_err(internal)?;
    let response = router.oneshot(request).await.map_err(internal)?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .map(|value| value.to_str())
        .transpose()
        .map_err(internal)?
        .unwrap_or("")
        .into();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .map_err(internal)?;
    Ok(WebResponse {
        status,
        content_type,
        body: Uint8Array::from(bytes.as_ref()),
    })
}

/// Cancellation handle for a change stream. Closing or freeing it stops delivery.
#[wasm_bindgen]
pub struct Subscription {
    id: u64,
}

#[wasm_bindgen]
impl Subscription {
    pub fn close(&self) {
        cancel_subscription(self.id);
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.close();
    }
}

fn cancel_subscription(id: u64) {
    RUNTIME.with(|runtime| {
        if let Some(abort) = runtime.borrow_mut().subscriptions.remove(&id) {
            abort.abort();
        }
    });
}

fn subscription_open(id: u64) -> bool {
    RUNTIME.with(|runtime| runtime.borrow().subscriptions.contains_key(&id))
}

struct JsSink {
    id: u64,
    on_change: Function,
}

impl tessera_api::ChangeSink for JsSink {
    type Error = JsValue;
    async fn emit(&mut self, event: String) -> Result<tessera_api::StreamStop, JsValue> {
        // The callback may synchronously close its subscription or reset the workshop.
        if !subscription_open(self.id) {
            return Ok(tessera_api::StreamStop::Stop);
        }
        self.on_change
            .call1(&JsValue::UNDEFINED, &JsValue::from_str(&event))?;
        if !subscription_open(self.id) {
            return Ok(tessera_api::StreamStop::Stop);
        }
        Ok(tessera_api::StreamStop::Continue)
    }
}

/// Subscribe before catching up, then deliver committed changes in cursor order.
#[wasm_bindgen]
pub fn subscribe(
    after: f64,
    #[wasm_bindgen(unchecked_param_type = "(eventJson: string) => void")] on_change: Function,
) -> Result<Subscription, JsValue> {
    let changes = with_app(|app| Ok(app.handles.changes.clone()))?;
    let workshop = with_app(|app| Ok(app.handles.workshop.clone()))?;
    let (abort, registration) = AbortHandle::new_pair();
    let id = RUNTIME.with(|runtime| {
        let mut runtime = runtime.borrow_mut();
        runtime.next_subscription += 1;
        let id = runtime.next_subscription;
        runtime.subscriptions.insert(id, abort);
        id
    });
    wasm_bindgen_futures::spawn_local(async move {
        let mut sink = JsSink { id, on_change };
        let result = Abortable::new(
            async move {
                tessera_api::follow_changes(
                    &changes,
                    workshop,
                    after as i64,
                    100,
                    || subscription_open(id),
                    &mut sink,
                    std::future::pending(),
                )
                .await
                .map_err(|error| match error {
                    tessera_api::FollowError::Workshop(error) => internal(error),
                    tessera_api::FollowError::Encode(error) => internal(error),
                    tessera_api::FollowError::Sink(error) => error,
                })
            },
            registration,
        )
        .await;
        cancel_subscription(id);
        if let Ok(Err(error)) = result {
            // Do not silently lose a stream when workshop history or a callback fails.
            wasm_bindgen::throw_val(error);
        }
    });
    Ok(Subscription { id })
}

/// Erase the workshop, interrupted restore, and upgrade copy, then reopen empty.
#[wasm_bindgen]
pub async fn reset() -> Result<(), JsValue> {
    close_app();
    with_pool(|pool| {
        // This dedicated pool belongs to the browser workshop.
        for filename in pool.list() {
            pool.delete_db(&filename).map_err(pool_error)?;
        }
        Ok(())
    })?;
    reopen()?;
    Ok(())
}
