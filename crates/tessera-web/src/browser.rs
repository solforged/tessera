use std::{cell::RefCell, collections::HashMap};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, header::CONTENT_TYPE},
};
use futures_util::future::{AbortHandle, Abortable};
use js_sys::{Function, JsString, Uint8Array};
use sqlite_wasm_vfs::sahpool::{OpfsSAHError, OpfsSAHPoolCfg, OpfsSAHPoolUtil};
use tessera_core::Notebook;
use tessera_service::BrowserHandles;
use tokio::sync::broadcast;
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

struct App {
    router: Router,
    handles: BrowserHandles,
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
            .ok_or_else(|| internal("The notebook is not open."))?;
        operation(app)
    })
}

fn reopen() -> Result<String, JsValue> {
    let notebook = Notebook::open("/demo").map_err(internal)?;
    let info = serde_json::to_string(&notebook.info().map_err(internal)?).map_err(internal)?;
    let (router, handles) = tessera_service::browser_router(notebook);
    RUNTIME.with(|runtime| runtime.borrow_mut().app = Some(App { router, handles }));
    Ok(info)
}

/// Acquire this browser origin's exclusive OPFS pool and open its notebook.
#[wasm_bindgen]
pub async fn open() -> Result<String, JsValue> {
    if RUNTIME.with(|runtime| runtime.borrow().app.is_some()) {
        return with_app(|app| {
            serde_json::to_string(&app.handles.notebook.lock().info().map_err(internal)?)
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
        RUNTIME.with(|runtime| runtime.borrow_mut().pool = Some(pool));
    }
    reopen()
}

/// An empty notebook needs the demo's initial pages and journals.
#[wasm_bindgen]
pub fn is_empty() -> Result<bool, JsValue> {
    with_app(|app| {
        let notebook = app.handles.notebook.lock();
        // The Fields page is created by migrations, before any user/demo content.
        let fields_page = notebook.fields().map_err(internal)?.page_id;
        Ok(!notebook
            .roots()
            .map_err(internal)?
            .iter()
            .any(|root| root.id != fields_page))
    })
}

/// A buffered HTTP response from the shared notebook router.
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

/// Dispatch an HTTP request to exactly the same notebook handlers as the service.
#[wasm_bindgen]
pub async fn handle(
    method: String,
    path: String,
    #[wasm_bindgen(unchecked_param_type = "string | undefined")] content_type: Option<String>,
    body: Vec<u8>,
) -> Result<WebResponse, JsValue> {
    let router = with_app(|app| Ok(app.router.clone()))?;
    let mut request = Request::builder().method(method.as_str()).uri(path);
    if let Some(content_type) = content_type {
        request = request.header(CONTENT_TYPE, content_type);
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

fn catch_up(id: u64, after: &mut i64, on_change: &Function) -> Result<(), JsValue> {
    loop {
        if !RUNTIME.with(|runtime| runtime.borrow().subscriptions.contains_key(&id)) {
            return Ok(());
        }
        let changes = with_app(|app| {
            app.handles
                .notebook
                .lock()
                .changes_since(*after, 100)
                .map_err(internal)
        })?;
        if changes.is_empty() {
            return Ok(());
        }
        for change in changes {
            // The callback may synchronously close its subscription or reset the notebook.
            if !RUNTIME.with(|runtime| runtime.borrow().subscriptions.contains_key(&id)) {
                return Ok(());
            }
            if change.seq > *after {
                let json = serde_json::to_string(&change).map_err(internal)?;
                on_change.call1(&JsValue::UNDEFINED, &JsValue::from_str(&json))?;
                *after = change.seq;
            }
        }
    }
}

async fn stream_changes(
    id: u64,
    mut receiver: broadcast::Receiver<i64>,
    mut after: i64,
    on_change: Function,
) -> Result<(), JsValue> {
    catch_up(id, &mut after, &on_change)?;
    loop {
        match receiver.recv().await {
            Ok(seq) if seq <= after => continue,
            Err(broadcast::error::RecvError::Closed) => return Ok(()),
            // Notifications may overflow, but committed notebook history never does.
            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
        }
        catch_up(id, &mut after, &on_change)?;
    }
}

/// Subscribe before catching up, then deliver committed changes in cursor order.
#[wasm_bindgen]
pub fn subscribe(
    after: f64,
    #[wasm_bindgen(unchecked_param_type = "(eventJson: string) => void")] on_change: Function,
) -> Result<Subscription, JsValue> {
    let receiver = with_app(|app| Ok(app.handles.changes.subscribe()))?;
    let (abort, registration) = AbortHandle::new_pair();
    let id = RUNTIME.with(|runtime| {
        let mut runtime = runtime.borrow_mut();
        runtime.next_subscription += 1;
        let id = runtime.next_subscription;
        runtime.subscriptions.insert(id, abort);
        id
    });
    wasm_bindgen_futures::spawn_local(async move {
        let result = Abortable::new(
            stream_changes(id, receiver, after as i64, on_change),
            registration,
        )
        .await;
        cancel_subscription(id);
        if let Ok(Err(error)) = result {
            // Do not silently lose a stream when notebook history or a callback fails.
            wasm_bindgen::throw_val(error);
        }
    });
    Ok(Subscription { id })
}

/// Close the notebook, remove its OPFS files, and reopen it empty.
#[wasm_bindgen]
pub async fn reset() -> Result<(), JsValue> {
    RUNTIME.with(|runtime| {
        let mut runtime = runtime.borrow_mut();
        for (_, abort) in runtime.subscriptions.drain() {
            abort.abort();
        }
        // Subscription tasks hold receivers, not notebook handles. Dropping the router and
        // browser handles closes SQLite before the pool deletes the database and journal.
        runtime.app = None;
        let pool = runtime
            .pool
            .as_ref()
            .ok_or_else(|| internal("The notebook is not open."))?;
        for filename in [
            "/demo/notebook.db",
            "/demo/notebook.db-journal",
            "/demo/notebook.db-wal",
            "/demo/notebook.db-shm",
        ] {
            pool.delete_db(filename).map_err(pool_error)?;
        }
        Ok::<_, JsValue>(())
    })?;
    reopen()?;
    Ok(())
}
