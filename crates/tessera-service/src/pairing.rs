//! Five-minute, single-use codes live only in the service process. Device keys are
//! random bearer credentials; only their hashes are retained by the hub workshop.

use std::fmt::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    Json, Router,
    extract::{Path, Request, State, rejection::JsonRejection},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tessera_core::sync_devices::{DeviceInfo, PairedDevice, RetainedPatches};

use crate::{AppState, error::ApiError, read, run, sharing};

const LIFETIME_MS: i64 = 5 * 60 * 1000;
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

#[derive(Default)]
pub(crate) enum Pairing {
    #[default]
    None,
    Waiting {
        code: String,
        expires_at: i64,
        attempts: u8,
    },
    Paired(PairedDevice),
    Expired,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

impl Pairing {
    fn expire(&mut self, now: i64) {
        if matches!(self, Self::Waiting { expires_at, .. } if now >= *expires_at) {
            *self = Self::Expired;
        }
    }

    fn check(&mut self, supplied: &str, now: i64) -> Result<(), ApiError> {
        self.expire(now);
        let Self::Waiting { code, attempts, .. } = self else {
            return Err(ApiError::new(
                StatusCode::GONE,
                "expired_code",
                "The pairing code has expired.",
            ));
        };
        let normalized: String = supplied
            .chars()
            .filter(|c| *c != '-' && *c != ' ')
            .map(|c| c.to_ascii_uppercase())
            .collect();
        if normalized != *code {
            *attempts += 1;
            if *attempts >= 5 {
                *self = Self::None;
            }
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "bad_code",
                "The pairing code is incorrect.",
            ));
        }
        Ok(())
    }
}

pub(crate) fn editor_routes() -> Router<AppState> {
    Router::new()
        .route("/api/sync/pairing", post(create).get(poll).delete(cancel))
        .route("/api/sync/devices", get(devices))
        .route("/api/sync/devices/{id}", delete(forget))
        .route("/api/sync/sharing", post(set_sharing))
}

pub(crate) fn public_routes() -> Router<AppState> {
    Router::new().route("/api/sync/pair", post(pair))
}

pub(crate) async fn authenticate(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let key = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or_else(unpaired)?
        .to_owned();
    let device = read(&state, move |workshop| workshop.sync_authenticate(&key))
        .await?
        .ok_or_else(unpaired)?;
    request.extensions_mut().insert(device);
    Ok(next.run(request).await)
}

pub(crate) async fn authenticate_loopback(
    state: State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if request.headers().contains_key(header::AUTHORIZATION) {
        authenticate(state, request, next).await
    } else {
        Ok(next.run(request).await)
    }
}

fn unpaired() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "unpaired",
        "Pair this device first.",
    )
}

pub(crate) fn check_device(
    workshop: &tessera_core::Workshop,
    paired: Option<&PairedDevice>,
    replica: &str,
) -> Result<(), ApiError> {
    if let Some(paired) = paired
        && !workshop.sync_device_owns_replica(&paired.id, replica)?
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "wrong_device",
            "This replica belongs to another device.",
        ));
    }
    Ok(())
}

pub(crate) async fn run_authorized<T: Send + 'static>(
    state: &AppState,
    paired: Option<axum::Extension<PairedDevice>>,
    replica: String,
    operation: impl FnOnce(&mut tessera_core::Workshop) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    run(state, move |workshop| {
        Ok(
            check_device(workshop, paired.as_ref().map(|p| &p.0), &replica)
                .and_then(|()| operation(workshop).map_err(ApiError::from)),
        )
    })
    .await?
}
fn qr_svg(url: &str, code: &str) -> Result<String, ApiError> {
    let url = percent_encoding::utf8_percent_encode(url, percent_encoding::NON_ALPHANUMERIC);
    let qr = qrcodegen::QrCode::encode_text(
        &format!("tessera://pair?hub={url}&code={code}"),
        qrcodegen::QrCodeEcc::Medium,
    )
    .map_err(ApiError::internal)?;

    let size = qr.size() + 8;
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\"><rect width=\"100%\" height=\"100%\" fill=\"white\"/><path fill=\"black\" d=\""
    );
    for y in 0..qr.size() {
        for x in 0..qr.size() {
            if qr.get_module(x, y) {
                write!(svg, "M{},{}h1v1h-1z ", x + 4, y + 4).expect("writing a String cannot fail");
            }
        }
    }
    svg.push_str("\"/></svg>");
    Ok(svg)
}

/// The code a new device types or scans to join, and when it stops working.
#[derive(Serialize, ts_rs::TS)]
pub(crate) struct PairingCode {
    code: String,
    display: String,
    expires_at: i64,
    url: String,
    qr_svg: String,
}

async fn create(State(state): State<AppState>) -> Result<Response, ApiError> {
    let sharing = sharing::status(state.sync_port).await;
    let url = sharing.url.filter(|_| sharing.on).ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "sharing_off",
            "Turn sharing on first.",
        )
    })?;
    let mut bytes = [0; 8];
    getrandom::fill(&mut bytes).map_err(ApiError::internal)?;
    let code: String = bytes
        .iter()
        .map(|b| ALPHABET[(b & 31) as usize] as char)
        .collect();
    let expires_at = now_ms() + LIFETIME_MS;
    let svg = qr_svg(&url, &code)?;
    let response = PairingCode {
        code: code.clone(),
        display: format!("{}-{}", &code[..4], &code[4..]),
        expires_at,
        url,
        qr_svg: svg,
    };
    *state.pairing.lock() = Pairing::Waiting {
        code,
        expires_at,
        attempts: 0,
    };
    Ok(Json(response).into_response())
}

#[derive(Serialize, ts_rs::TS)]
pub(crate) struct PairingStatus {
    #[ts(type = "\"none\" | \"waiting\" | \"paired\" | \"expired\"")]
    state: &'static str,
    device: Option<PairedDevice>,
}

async fn poll(State(state): State<AppState>) -> Json<PairingStatus> {
    let mut pairing = state.pairing.lock();
    pairing.expire(now_ms());
    let (status, device) = match &*pairing {
        Pairing::None => ("none", None),
        Pairing::Waiting { .. } => ("waiting", None),
        Pairing::Paired(device) => ("paired", Some(device.clone())),
        Pairing::Expired => ("expired", None),
    };
    Json(PairingStatus {
        state: status,
        device,
    })
}

async fn cancel(State(state): State<AppState>) -> StatusCode {
    *state.pairing.lock() = Pairing::None;
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    name: String,
}

async fn pair(
    State(state): State<AppState>,
    request: Result<Json<PairRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = request?;
    let pairing = state.pairing.clone();
    let response = run(&state, move |workshop| {
        Ok((|| {
            let mut pairing = pairing.lock();
            pairing.check(&request.code, now_ms())?;
            let mut bytes = [0; 32];
            getrandom::fill(&mut bytes).map_err(ApiError::internal)?;
            let key = URL_SAFE_NO_PAD.encode(bytes);
            let device = workshop.sync_pair_device(&request.name, &key)?;
            let info = workshop.info()?;
            *pairing = Pairing::Paired(device.clone());
            Ok::<_, ApiError>((key, device, info.id))
        })())
    })
    .await??;
    Ok(Json(json!({"key":response.0,"device":response.1,"hub":{"name":sharing::hub_name().await,"notebook_id":response.2,"schema_version":tessera_core::SCHEMA_VERSION}})).into_response())
}

/// A paired device as the Mac lists it: its pairing, whether it syncs, and how its last attempts went.
#[derive(Serialize, ts_rs::TS)]
#[ts(rename = "PairedDevice")]
pub(crate) struct DeviceRecord {
    #[serde(flatten)]
    device: DeviceInfo,
    #[serde(flatten)]
    health: crate::sync::DeviceHealth,
}

#[derive(Serialize, ts_rs::TS)]
pub(crate) struct SyncDevices {
    this_device: crate::SyncVersion,
    sharing: sharing::Sharing,
    hub_name: String,
    devices: Vec<DeviceRecord>,
    retained: RetainedPatches,
}

async fn devices(State(state): State<AppState>) -> Result<Response, ApiError> {
    let (devices, retained) = run(&state, |workshop| {
        Ok((workshop.sync_devices()?, workshop.sync_retained_patches()?))
    })
    .await?;
    let devices = {
        let health = state.sync_health.lock();
        devices
            .into_iter()
            .map(|device| DeviceRecord {
                health: health.get(&device.id).cloned().unwrap_or_default(),
                device,
            })
            .collect()
    };
    Ok(Json(SyncDevices {
        this_device: crate::SyncVersion::current(),
        sharing: sharing::status(state.sync_port).await,
        hub_name: sharing::hub_name().await,
        devices,
        retained,
    })
    .into_response())
}

#[derive(Deserialize)]
struct SharingRequest {
    on: bool,
}

async fn set_sharing(
    State(state): State<AppState>,
    request: Result<Json<SharingRequest>, JsonRejection>,
) -> Result<Json<sharing::Sharing>, ApiError> {
    let Json(request) = request?;
    // Serialize toggles so a slow enable cannot complete after a later disable.
    let _guard = state.sharing.lock().await;
    let sharing = sharing::set(state.sync_port, request.on)
        .await
        .map_err(|message| ApiError::new(StatusCode::CONFLICT, "sharing_taken", message))?;
    if !sharing.on {
        *state.pairing.lock() = Pairing::None;
    }
    Ok(Json(sharing))
}

async fn forget(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let forgotten = id.clone();
    run(&state, move |workshop| workshop.sync_forget_device(&id)).await?;
    state.sync_health.lock().remove(&forgotten);
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
        middleware,
    };
    use parking_lot::Mutex;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn waiting(expires_at: i64) -> Pairing {
        Pairing::Waiting {
            code: "4F7K92QD".into(),
            expires_at,
            attempts: 0,
        }
    }

    #[test]
    fn codes_expire_at_deadline_and_cancel_after_five_wrong_attempts() {
        let mut code = waiting(300_000);
        assert!(code.check(" 4f7k-92qd ", 299_999).is_ok());
        assert_eq!(
            code.check("4F7K92QD", 300_000)
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::GONE
        );
        assert!(matches!(code, Pairing::Expired));
        let mut code = waiting(300_000);
        for _ in 0..5 {
            assert_eq!(
                code.check("WRONG", 0).unwrap_err().into_response().status(),
                StatusCode::FORBIDDEN
            );
        }
        assert!(matches!(code, Pairing::None));
        assert_eq!(
            code.check("4F7K92QD", 0)
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::GONE
        );
    }

    async fn request(
        app: &Router,
        path: &str,
        key: Option<&str>,
        body: serde_json::Value,
    ) -> Response {
        let mut request = Request::post(path)
            .header(header::CONTENT_TYPE, "application/json")
            .header(crate::sync::SCHEMA_HEADER, tessera_core::SCHEMA_VERSION);
        if let Some(key) = key {
            request = request.header(header::AUTHORIZATION, format!("Bearer {key}"));
        }
        app.clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap()
    }

    async fn value(response: Response) -> serde_json::Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
    }

    /// A hub's sync listener with code 4F7K-92QD waiting, reading beside its
    /// writer as the service does.
    fn hub(dir: &std::path::Path) -> (AppState, Router) {
        let workshop = tessera_core::Workshop::open(dir).unwrap();
        let readers = tessera_api::Readers::open(&workshop).unwrap();
        let workshop = Arc::new(Mutex::new(workshop));
        let changes = tokio::sync::broadcast::channel(256).0;
        let state = AppState {
            readers: Some(readers),
            library: crate::library::Library::start(
                workshop.clone(),
                changes.clone(),
                crate::library::extract,
            )
            .unwrap(),
            objects: crate::state::hub_objects(),
            workshop,
            changes,
            assets: None,
            port: 4500,
            sync_port: 4501,
            backup: Arc::new(tokio::sync::Mutex::new(None)),
            backup_store: None,
            pairing: Arc::new(Mutex::new(waiting(now_ms() + LIFETIME_MS))),
            sharing: Arc::new(tokio::sync::Mutex::new(())),
            replica: Arc::default(),
            sync_health: Arc::default(),
            switcher: None,
            agent: Arc::new(crate::agent::Runtime::new(Some(dir.join("agent.json"))).unwrap()),
        };
        let app = crate::sync::routes()
            .layer(middleware::from_fn_with_state(
                state.clone(),
                crate::sync::record_health,
            ))
            .layer(middleware::from_fn_with_state(state.clone(), authenticate))
            .merge(public_routes())
            .layer(middleware::from_fn(crate::sync::version_headers))
            .with_state(state.clone());
        (state, app)
    }

    #[tokio::test]
    async fn schema_refusals_remember_the_paired_version_until_a_request_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let (state, app) = hub(dir.path());
        let device = state
            .workshop
            .lock()
            .sync_pair_device("Fold", "paired-key")
            .unwrap();
        for count in 1..=2 {
            let response = app
                .clone()
                .oneshot(
                    Request::post("/api/sync/objects/missing")
                        .header(header::AUTHORIZATION, "Bearer paired-key")
                        .header(header::CONTENT_TYPE, "application/json")
                        .header(crate::sync::SCHEMA_HEADER, tessera_core::SCHEMA_VERSION - 2)
                        .header(crate::sync::VERSION_HEADER, "0.2.0")
                        .header(crate::sync::BUILD_HEADER, "old-build")
                        .body(Body::from(r#"{"ids":[]}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(
                response.headers()[crate::sync::SCHEMA_HEADER],
                tessera_core::SCHEMA_VERSION.to_string()
            );
            let response = value(response).await;
            assert_eq!(response["error"]["code"], "schema_mismatch");
            assert_eq!(
                response["error"]["details"]["hub"]["schema"],
                tessera_core::SCHEMA_VERSION
            );
            assert_eq!(
                response["error"]["details"]["replica_schema"],
                tessera_core::SCHEMA_VERSION - 2
            );
            let health = state.sync_health.lock();
            let health = &health[&device.id];
            let version = health.version.as_ref().unwrap();
            assert_eq!(version.schema, tessera_core::SCHEMA_VERSION - 2);
            assert_eq!(version.version.as_deref(), Some("0.2.0"));
            assert_eq!(version.build.as_deref(), Some("old-build"));
            assert_eq!(health.refused.as_ref().unwrap().code, "schema_mismatch");
            assert_eq!(health.refused.as_ref().unwrap().attempts, count);
            assert_eq!(health.attempts.len(), 1);
            assert_eq!(health.attempts[0].count, count);
            assert_eq!(
                health.attempts[0].first_at,
                health.refused.as_ref().unwrap().since
            );
        }
        let accepted = request(
            &app,
            "/api/sync/objects/missing",
            Some("paired-key"),
            json!({"ids":[]}),
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::OK);
        let health = state.sync_health.lock();
        let health = &health[&device.id];
        assert!(health.refused.is_none());
        assert_eq!(
            health.version.as_ref().unwrap().schema,
            tessera_core::SCHEMA_VERSION
        );
        assert_eq!(health.attempts.len(), 2);
        assert!(health.attempts[0].ok);
        assert!(!health.attempts[1].ok);
    }

    #[tokio::test]
    async fn a_paired_device_reads_from_the_hub_while_a_save_holds_the_writer() {
        let dir = tempfile::tempdir().unwrap();
        let (state, app) = hub(dir.path());
        let sha = {
            let mut workshop = state.workshop.lock();
            workshop.sync_pair_device("Fold", "paired-key").unwrap();
            workshop.put_object(b"stored file").unwrap()
        };
        let absent = "0".repeat(64);
        // A save holds the writer on another thread until the reads finish.
        let (held, saving) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let workshop = state.workshop.clone();
        let save = std::thread::spawn(move || {
            let _writer = workshop.lock();
            held.send(()).unwrap();
            let _ = released.recv();
        });
        saving.recv().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let missing = request(
                &app,
                "/api/sync/objects/missing",
                Some("paired-key"),
                serde_json::json!({"ids": [sha, absent]}),
            )
            .await;
            assert_eq!(missing.status(), StatusCode::OK);
            assert_eq!(value(missing).await["ids"], serde_json::json!([absent]));
            for (path, body) in [
                (
                    "/api/sync/snapshots/missing",
                    serde_json::json!({"ids": []}),
                ),
                (
                    "/api/sync/snapshots/content",
                    serde_json::json!({"ids": [], "from": 0}),
                ),
            ] {
                let response = request(&app, path, Some("paired-key"), body).await;
                assert_eq!(response.status(), StatusCode::OK, "{path}");
            }
            let object = app
                .clone()
                .oneshot(
                    Request::get(format!("/api/sync/objects/{sha}"))
                        .header(header::AUTHORIZATION, "Bearer paired-key")
                        .header(crate::sync::SCHEMA_HEADER, tessera_core::SCHEMA_VERSION)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(object.status(), StatusCode::OK);
            assert_eq!(
                &to_bytes(object.into_body(), 1024).await.unwrap()[..],
                b"stored file"
            );
        })
        .await
        .expect("a sync read waited for the writer");
        drop(release);
        save.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_forgotten_phone_pairs_again_and_sends_only_its_own_changes() {
        let hub_dir = tempfile::tempdir().unwrap();
        let (state, app) = hub(hub_dir.path());
        let page = |title: &str| tessera_core::Batch {
            actor: tessera_core::Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![tessera_core::Operation::CreatePage {
                id: ulid::Ulid::generate().to_string(),
                title: title.into(),
            }],
        };
        // A change from before change IDs. The phone's copy must not send it back.
        state
            .workshop
            .lock()
            .apply(&page("Written on the Mac"))
            .unwrap();
        rusqlite::Connection::open(hub_dir.path().join(tessera_core::DATABASE_FILE))
            .unwrap()
            .execute(
                "UPDATE changes SET change_id = NULL, origin = NULL WHERE seq = (SELECT MAX(seq) FROM changes)",
                [],
            )
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        let phone_dir = tempfile::tempdir().unwrap();
        let (phone, handles) =
            crate::embedded_router(tessera_core::Workshop::open(phone_dir.path()).unwrap())
                .unwrap();
        let before = handles.workshop.lock().info().unwrap().id;
        let join = json!({"url": url, "code": "4f7k-92qd", "name": "Phone"});
        assert_eq!(
            request(&phone, "/api/sync/join", None, join.clone())
                .await
                .status(),
            StatusCode::OK
        );
        // The clone replaced the workshop in place, so a window bound to the old one must reload.
        let stale = phone
            .clone()
            .oneshot(
                Request::get("/api/roots")
                    .header("X-Tessera-Notebook", before)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        assert_eq!(value(stale).await["error"]["code"], "notebook_changed");
        let device = state.workshop.lock().sync_devices().unwrap()[0].id.clone();
        forget(State(state.clone()), Path(device))
            .await
            .unwrap_or_else(|_| panic!("forget failed"));
        let forgotten = page("Written after Forget");
        let id = match &forgotten.operations[0] {
            tessera_core::Operation::CreatePage { id, .. } => id.clone(),
            _ => unreachable!(),
        };
        handles.workshop.lock().apply(&forgotten).unwrap();
        let synced = value(request(&phone, "/api/sync/run", None, json!({})).await).await;
        assert_eq!(synced["replica"]["last_error"]["code"], "unpaired");
        assert_eq!(synced["replica"]["pending"], 1);
        *state.pairing.lock() = waiting(now_ms() + LIFETIME_MS);
        let again = request(&phone, "/api/sync/join", None, join).await;
        let status = again.status();
        let again = value(again).await;
        assert_eq!(status, StatusCode::OK, "{again}");
        assert_eq!(again["replica"]["pending"], 0);
        assert_eq!(again["replica"]["rejected"], 0);
        assert!(again["replica"]["last_error"].is_null());
        assert_eq!(
            state.workshop.lock().block(&id).unwrap().text,
            "Written after Forget"
        );
    }

    #[tokio::test]
    async fn single_use_keys_bind_replicas_and_forget_revokes_access() {
        let dir = tempfile::tempdir().unwrap();
        let (state, app) = hub(dir.path());
        for key in [None, Some("unknown")] {
            let response = request(&app, "/api/sync/clone", key, json!({})).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(value(response).await["error"]["code"], "unpaired");
        }
        let paired = request(
            &app,
            "/api/sync/pair",
            None,
            json!({"code":"4f7k-92qd","name":"Phone"}),
        )
        .await;
        assert_eq!(paired.status(), StatusCode::OK);
        let paired = value(paired).await;
        let key = paired["key"].as_str().unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(key).unwrap().len(), 32);
        let reused = request(
            &app,
            "/api/sync/pair",
            None,
            json!({"code":"4F7K92QD","name":"Other"}),
        )
        .await;
        assert_eq!(reused.status(), StatusCode::GONE);
        assert_eq!(value(reused).await["error"]["code"], "expired_code");
        let response = request(&app, "/api/sync/clone", Some(key), json!({})).await;
        assert_eq!(response.status(), StatusCode::OK);
        let ticket: tessera_core::sync::CloneTicket = serde_json::from_str(
            response.headers()[crate::sync::TICKET_HEADER]
                .to_str()
                .unwrap(),
        )
        .unwrap();
        let _ = to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap();
        let other = state
            .workshop
            .lock()
            .sync_pair_device("Other", "other-key")
            .unwrap();
        for (path, body) in [
            (
                "/api/sync/push",
                json!({"device":ticket.device_id,"changes":[]}),
            ),
            (
                "/api/sync/pull",
                json!({"device":ticket.device_id,"acknowledged":ticket.seq,"after":ticket.seq}),
            ),
            (
                "/api/sync/rows",
                json!({"device":ticket.device_id,"rows":{"positions":[],"surfacings":[]},"after":0}),
            ),
            ("/api/sync/retire", json!({"device":ticket.device_id})),
        ] {
            let wrong = request(&app, path, Some("other-key"), body.clone()).await;
            assert_eq!(wrong.status(), StatusCode::FORBIDDEN, "{path}");
            assert_eq!(value(wrong).await["error"]["code"], "wrong_device");
            let allowed = request(&app, path, Some(key), body).await;
            assert!(
                allowed.status().is_success(),
                "{path}: {}",
                allowed.status()
            );
        }
        assert!(
            !state
                .workshop
                .lock()
                .sync_device_owns_replica(&other.id, &ticket.device_id)
                .unwrap()
        );
        forget(
            State(state.clone()),
            Path(paired["device"]["id"].as_str().unwrap().to_owned()),
        )
        .await
        .unwrap_or_else(|_| panic!("forget failed"));
        let revoked = request(&app, "/api/sync/clone", Some(key), json!({})).await;
        assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(value(revoked).await["error"]["code"], "unpaired");
    }
}
