use std::collections::BTreeMap;

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::store::{Protocol, Provider};
use crate::error::ApiError;

#[derive(Clone)]
pub(super) struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

pub(super) enum Message {
    User(String),
    Assistant {
        text: String,
        calls: Vec<ToolCall>,
    },
    Result {
        id: String,
        text: String,
        error: bool,
    },
}

pub(super) struct Reply {
    pub text: String,
    pub calls: Vec<ToolCall>,
}

pub(super) struct Failure {
    pub status: StatusCode,
    pub message: String,
}

impl Failure {
    fn stream(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.into(),
        }
    }

    pub fn api(self) -> ApiError {
        ApiError::new(self.status, "agent_provider", self.message)
    }
}

fn messages(protocol: Protocol, history: &[Message]) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::with_capacity(history.len());
    for message in history {
        let message = match (protocol, message) {
            (_, Message::User(text)) => json!({"role": "user", "content": text}),
            (Protocol::Openai, Message::Assistant { text, calls }) => {
                let mut message = json!({"role":"assistant", "content": text});
                if !calls.is_empty() {
                    message["tool_calls"] = calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id":call.id, "type":"function",
                                "function":{"name":call.name,"arguments":call.arguments}
                            })
                        })
                        .collect();
                }
                message
            }
            (Protocol::Openai, Message::Result { id, text, .. }) => {
                json!({"role":"tool", "tool_call_id":id,"content":text})
            }
            (Protocol::Anthropic, Message::Assistant { text, calls }) => {
                let mut content = Vec::new();
                if !text.is_empty() {
                    content.push(json!({"type":"text","text":text}));
                }
                for call in calls {
                    content.push(json!({"type":"tool_use","id":call.id,"name":call.name,
                        "input":serde_json::from_str::<Value>(&call.arguments).unwrap_or_else(|_| json!({}))}));
                }
                json!({"role":"assistant","content":content})
            }
            (Protocol::Anthropic, Message::Result { id, text, error }) => {
                let result =
                    json!({"type":"tool_result","tool_use_id":id,"content":text,"is_error":error});
                // Anthropic requires all results for one assistant message together.
                if let Some(previous) = messages.last_mut().filter(|m| m["role"] == "user")
                    && let Some(content) = previous["content"].as_array_mut()
                {
                    content.push(result);
                    continue;
                }
                json!({"role":"user","content":[result]})
            }
        };
        messages.push(message);
    }
    messages
}

pub(super) async fn complete(
    client: &reqwest::Client,
    provider: &Provider,
    system: &str,
    history: &[Message],
    tools: &[Value],
    max_tokens: u32,
    mut text_delta: impl FnMut(&str),
) -> Result<Reply, Failure> {
    let mut history = messages(provider.protocol, history);
    let (path, mut body) = match provider.protocol {
        Protocol::Anthropic => (
            "v1/messages",
            json!({
                "model":provider.model,"system":system,"messages":history,
                "max_tokens":max_tokens,"stream":true
            }),
        ),
        Protocol::Openai => {
            history.insert(0, json!({"role":"system","content":system}));
            (
                "chat/completions",
                json!({"model":provider.model,"messages":history,
                "max_tokens":max_tokens,"stream":true}),
            )
        }
    };
    if !tools.is_empty() {
        body["tools"] = match provider.protocol {
            Protocol::Anthropic => tools.iter().map(|tool| json!({
                "name":tool["name"], "description":tool["description"], "input_schema":tool["parameters"]
            })).collect(),
            Protocol::Openai => tools.iter().map(|tool| json!({"type":"function","function":tool})).collect(),
        };
    }
    let mut request = client
        .post(format!("{}/{path}", provider.base_url))
        .json(&body);
    if !provider.api_key.is_empty() {
        let mut value = reqwest::header::HeaderValue::from_str(&match provider.protocol {
            Protocol::Anthropic => provider.api_key.clone(),
            Protocol::Openai => format!("Bearer {}", provider.api_key),
        })
        .map_err(|_| Failure::stream("The provider key is not a valid HTTP header."))?;
        value.set_sensitive(true);
        request = request.header(
            match provider.protocol {
                Protocol::Anthropic => "x-api-key",
                Protocol::Openai => "authorization",
            },
            value,
        );
    }
    if matches!(provider.protocol, Protocol::Anthropic) {
        request = request.header("anthropic-version", "2023-06-01");
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| Failure::stream(provider.redact(&error.without_url().to_string())))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let value = serde_json::from_str::<Value>(&text).ok();
        let message = value
            .as_ref()
            .and_then(|v| {
                v["error"]["message"]
                    .as_str()
                    .or_else(|| v["message"].as_str())
            })
            .unwrap_or(&text);
        return Err(Failure {
            status: if status.is_client_error() || status.is_server_error() {
                status
            } else {
                StatusCode::BAD_GATEWAY
            },
            message: format!(
                "HTTP {status}: {}",
                provider
                    .redact(message)
                    .chars()
                    .take(4000)
                    .collect::<String>()
            ),
        });
    }
    let mut decoder = Decoder::default();
    let mut stream = Stream::default();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| Failure::stream(provider.redact(&error.without_url().to_string())))?
    {
        for data in decoder.push(&chunk)? {
            if data == "[DONE]" {
                stream.ended = true;
                return Ok(stream.reply());
            }
            let event: Value = serde_json::from_str(&data)
                .map_err(|_| Failure::stream("The provider sent invalid stream data."))?;
            stream
                .event(provider.protocol, &event, &mut text_delta)
                .map_err(|mut error| {
                    error.message = provider.redact(&error.message);
                    error
                })?;
            if matches!(provider.protocol, Protocol::Anthropic) && stream.ended {
                return Ok(stream.reply());
            }
        }
    }
    if !stream.ended {
        return Err(Failure::stream(
            "The provider stream ended before completing its answer.",
        ));
    }
    Ok(stream.reply())
}

#[derive(Default)]
struct Stream {
    text: String,
    calls: BTreeMap<u64, ToolCall>,
    ended: bool,
}

impl Stream {
    fn delta(&mut self, text: &str, emit: &mut impl FnMut(&str)) {
        if !text.is_empty() {
            self.text.push_str(text);
            emit(text);
        }
    }

    fn event(
        &mut self,
        protocol: Protocol,
        event: &Value,
        emit: &mut impl FnMut(&str),
    ) -> Result<(), Failure> {
        if let Some(error) = event.get("error") {
            return Err(Failure::stream(
                error["message"]
                    .as_str()
                    .unwrap_or("Provider stream error."),
            ));
        }
        match protocol {
            Protocol::Openai => {
                if let Some(choices) = event["choices"].as_array() {
                    for choice in choices
                        .iter()
                        .filter(|c| c["index"].as_u64().unwrap_or(0) == 0)
                    {
                        let delta = &choice["delta"];
                        if let Some(text) = delta["content"]
                            .as_str()
                            .or_else(|| delta["refusal"].as_str())
                        {
                            self.delta(text, emit);
                        }
                        if let Some(calls) = delta["tool_calls"].as_array() {
                            for call in calls {
                                let index = call["index"].as_u64().ok_or_else(|| {
                                    Failure::stream("Provider tool call has no index.")
                                })?;
                                let entry = self.calls.entry(index).or_insert_with(|| ToolCall {
                                    id: String::new(),
                                    name: String::new(),
                                    arguments: String::new(),
                                });
                                if let Some(id) = call["id"].as_str() {
                                    entry.id.push_str(id);
                                }
                                if let Some(name) = call["function"]["name"].as_str() {
                                    entry.name.push_str(name);
                                }
                                if let Some(arguments) = call["function"]["arguments"].as_str() {
                                    entry.arguments.push_str(arguments);
                                }
                            }
                        }
                        if choice["finish_reason"].as_str().is_some() {
                            self.ended = true;
                        }
                    }
                }
            }
            Protocol::Anthropic => match event["type"].as_str() {
                Some("content_block_start") => {
                    let block = &event["content_block"];
                    match block["type"].as_str() {
                        Some("text") => {
                            self.delta(block["text"].as_str().unwrap_or_default(), emit)
                        }
                        Some("tool_use") => {
                            let index = event["index"].as_u64().ok_or_else(|| {
                                Failure::stream("Provider tool call has no index.")
                            })?;
                            let arguments = block["input"]
                                .as_object()
                                .filter(|o| !o.is_empty())
                                .map(|_| block["input"].to_string())
                                .unwrap_or_default();
                            self.calls.insert(
                                index,
                                ToolCall {
                                    id: block["id"].as_str().unwrap_or_default().into(),
                                    name: block["name"].as_str().unwrap_or_default().into(),
                                    arguments,
                                },
                            );
                        }
                        _ => {}
                    }
                }
                Some("content_block_delta") => match event["delta"]["type"].as_str() {
                    Some("text_delta") => {
                        self.delta(event["delta"]["text"].as_str().unwrap_or_default(), emit)
                    }
                    Some("input_json_delta") => {
                        let call = event["index"]
                            .as_u64()
                            .and_then(|index| self.calls.get_mut(&index))
                            .ok_or_else(|| {
                                Failure::stream("Provider sent an unknown tool call.")
                            })?;
                        call.arguments
                            .push_str(event["delta"]["partial_json"].as_str().unwrap_or_default());
                    }
                    _ => {}
                },
                Some("message_stop") => self.ended = true,
                _ => {}
            },
        }
        Ok(())
    }

    fn reply(self) -> Reply {
        Reply {
            text: self.text,
            calls: self.calls.into_values().collect(),
        }
    }
}

// Decode complete SSE lines as bytes first: UTF-8 characters may span HTTP chunks.
#[derive(Default)]
struct Decoder {
    line: Vec<u8>,
    data: String,
    carriage_return: bool,
}

impl Decoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, Failure> {
        let mut events = Vec::new();
        for &byte in bytes {
            if byte == b'\n' && self.carriage_return {
                self.carriage_return = false;
                continue;
            }
            self.carriage_return = byte == b'\r';
            if matches!(byte, b'\n' | b'\r') {
                let line = std::str::from_utf8(&self.line)
                    .map_err(|_| Failure::stream("The provider stream is not UTF-8."))?;
                if line.is_empty() {
                    if !self.data.is_empty() {
                        self.data.pop();
                        events.push(std::mem::take(&mut self.data));
                    }
                } else if let Some(data) = line.strip_prefix("data:") {
                    self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
                    self.data.push('\n');
                }
                self.line.clear();
            } else {
                self.line.push(byte);
            }
        }
        Ok(events)
    }
}
