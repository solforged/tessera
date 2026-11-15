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
    let watch = async move {
        while let Some(message) = stream.next().await {
            if matches!(message, Err(_) | Ok(axum::extract::ws::Message::Close(_))) {
                return;
            }
        }
    };
    let mut sink = SocketSink(sink);
    let _ = tessera_api::follow_changes(
        &state.changes,
        state.notebook.clone(),
        after,
        tessera_api::CHANGES_PAGE_SIZE,
        || true,
        &mut sink,
        watch,
    )
    .await;
}
