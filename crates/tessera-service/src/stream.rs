use axum::extract::{Query, State, rejection::QueryRejection};
use serde::Deserialize;

use crate::error::ApiError;
use crate::state::AppState;

#[derive(Deserialize)]
pub(crate) struct StreamQuery {
    #[serde(default)]
    after: i64,
}

pub(crate) async fn change_stream(
    State(state): State<AppState>,
    query: Result<Query<StreamQuery>, QueryRejection>,
    upgrade: axum::extract::ws::WebSocketUpgrade,
) -> Result<axum::response::Response, ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    Ok(upgrade.on_upgrade(move |socket| stream_socket(socket, state, query.after)))
}

struct SocketSink<S>(S);

impl<S> tessera_api::ChangeSink for SocketSink<S>
where
    S: futures_util::Sink<axum::extract::ws::Message, Error = axum::Error> + Unpin,
{
    type Error = axum::Error;
    async fn emit(&mut self, event: String) -> Result<tessera_api::StreamStop, Self::Error> {
        use futures_util::SinkExt;
        self.0
            .send(axum::extract::ws::Message::Text(event.into()))
            .await?;
        Ok(tessera_api::StreamStop::Continue)
    }
}

async fn stream_socket(socket: axum::extract::ws::WebSocket, state: AppState, after: i64) {
    use futures_util::StreamExt;
    let (sink, mut stream) = socket.split();
    let mut shutdown = state.shutdown.clone();
    let watch = async move {
        let stop = async {
            if shutdown.wait_for(|stop| *stop).await.is_err() {
                std::future::pending::<()>().await;
            }
        };
        tokio::pin!(stop);
        loop {
            tokio::select! {
                () = &mut stop => return,
                message = stream.next() => {
                    if matches!(
                        message,
                        None | Some(Err(_)) | Some(Ok(axum::extract::ws::Message::Close(_)))
                    ) {
                        return;
                    }
                }
            }
        }
    };
    let mut sink = SocketSink(sink);
    let _ = tessera_api::follow_changes(
        &state.changes,
        state.workshop.clone(),
        state.readers.clone(),
        after,
        tessera_api::CHANGES_PAGE_SIZE,
        || true,
        &mut sink,
        watch,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use std::time::Duration;
    use tessera_core::Workshop;
    use tokio_tungstenite::connect_async;

    #[tokio::test]
    async fn shutdown_closes_open_change_streams_without_waiting_for_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Workshop::open(dir.path().join("workshop")).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let (app, _sync, _state) = crate::router::routers(
            workshop,
            port,
            port.saturating_add(1),
            None,
            None,
            None,
            None,
            None,
            stopped.clone(),
        )
        .unwrap();
        let mut server_stopped = stopped;
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = server_stopped.wait_for(|stop| *stop).await;
                })
                .await
                .unwrap();
        });
        let (_socket, _) = connect_async(format!("ws://127.0.0.1:{port}/api/changes/stream"))
            .await
            .unwrap();
        stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_millis(500), server)
            .await
            .expect("open change stream should exit immediately on shutdown")
            .unwrap();
    }
}
