//! `tessera mcp`: a Model Context Protocol server on stdin and stdout for
//! agents. Each tool call goes to the running notebook service over its
//! loopback HTTP API, so the service stays the only writer. Messages are
//! newline-delimited JSON-RPC 2.0; logs go to stderr.

mod cards;
mod library;
mod notes;
mod outline;
mod query;
mod relations;
use tessera_service::agent_render as render;
mod revisits;
mod sync;
mod tasks;
mod tools;

use std::path::Path;

use anyhow::Context;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tessera_core::{Actor, AgentEdit, AgentReceipt, AgentRequest};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::service;
use render::{kind_label, quoted};

/// Newest first; the client's version is echoed when it is one of these.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Tessera is a local outline workshop. Every note is a tree of \
blocks on a named page or a journal day. Search or read before writing to avoid duplicates. \
tessera_add_note appends to the end of a page, journal day or block; tessera_edit_block, \
tessera_move_block, tessera_delete_block, tessera_set_task and tessera_set_relation change existing blocks by the \
IDs tessera_read_page shows. Flashcards, tasks and field entries are written as block text \
(see tessera_add_note); tessera_cards, tessera_tasks and tessera_query read them back, and \
tessera_hold_card suspends a card; tessera_save_deck groups cards into decks. \
tessera_relations reads explicitly authored supports, disputes, qualifies and answers relations. \
tessera_library reads books and articles and tessera_cite links blocks to their passages. \
tessera_sync tells whether your edits have reached the workshop's hub. Every write is one \
change attributed to you and can be reversed with tessera_undo; tessera_recent_changes lists \
the workshop history.";

pub async fn serve(notebook: &Path) -> anyhow::Result<()> {
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    let mut session = Session {
        notebook,
        agent: "mcp".into(),
    };
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let Some(response) = session.message(&line).await else {
            continue;
        };
        let mut bytes = serde_json::to_vec(&response)?;
        bytes.push(b'\n');
        stdout.write_all(&bytes).await?;
        stdout.flush().await?;
    }
    Ok(())
}

struct Session<'a> {
    notebook: &'a Path,
    /// Attribution for writes, from the client's `initialize` name.
    agent: String,
}

impl Session<'_> {
    /// The response to one message; notifications and responses get none.
    async fn message(&mut self, line: &str) -> Option<Value> {
        let message: Value = match serde_json::from_str(line) {
            Ok(message) => message,
            Err(error) => return Some(failure(Value::Null, -32700, &error.to_string())),
        };
        let id = message.get("id").cloned()?;
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return message
                .get("result")
                .or(message.get("error"))
                .is_none()
                .then(|| failure(id, -32600, "A request needs a method."));
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        Some(match method {
            "initialize" => {
                if let Some(name) = params["clientInfo"]["name"].as_str() {
                    self.agent = name.to_owned();
                }
                let version = params["protocolVersion"]
                    .as_str()
                    .filter(|version| PROTOCOL_VERSIONS.contains(version))
                    .unwrap_or(PROTOCOL_VERSIONS[0]);
                success(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "tessera", "version": tessera_service::VERSION },
                        "instructions": INSTRUCTIONS,
                    }),
                )
            }
            "ping" => success(id, json!({})),
            "tools/list" => success(id, json!({ "tools": tools::tools() })),
            "tools/call" => {
                let name = params["name"].as_str().unwrap_or_default();
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                let result = match name {
                    "tessera_search" => self.search(&arguments).await,
                    "tessera_list_pages" => self.list_pages(&arguments).await,
                    "tessera_read_page" => self.read_page(&arguments).await,
                    "tessera_add_note" => self.add_note(&arguments).await,
                    "tessera_edit_block" => self.edit_block(&arguments).await,
                    "tessera_move_block" => self.move_block(&arguments).await,
                    "tessera_delete_block" => self.delete_block(&arguments).await,
                    "tessera_set_task" => self.set_task(&arguments).await,
                    "tessera_set_relation" => self.set_relation(&arguments).await,
                    "tessera_relations" => self.relations(&arguments).await,
                    "tessera_revisits" => self.revisits(&arguments).await,
                    "tessera_revisit" => self.revisit(&arguments).await,
                    "tessera_tasks" => self.tasks(&arguments).await,
                    "tessera_cards" => self.cards(&arguments).await,
                    "tessera_hold_card" => self.hold_card(&arguments).await,
                    "tessera_query" => self.query(&arguments).await,
                    "tessera_library" => self.library(&arguments).await,
                    "tessera_cite" => self.cite(&arguments).await,
                    "tessera_recent_changes" => self.recent_changes(&arguments).await,
                    "tessera_sync" => self.sync(&arguments).await,
                    "tessera_save_deck" => self.save_deck(&arguments).await,
                    "tessera_undo" => self.undo(&arguments).await,
                    _ => return Some(failure(id, -32602, &format!("Unknown tool: {name}"))),
                };
                let (text, error) = match result {
                    Ok(text) => match self.render_tags(&text).await {
                        Ok(text) => (text, false),
                        Err(error) => (format!("{error:#}"), true),
                    },
                    Err(error) => (format!("{error:#}"), true),
                };
                success(
                    id,
                    json!({ "content": [{ "type": "text", "text": text }], "isError": error }),
                )
            }
            _ => failure(id, -32601, &format!("Method not found: {method}")),
        })
    }

    fn actor(&self) -> Actor {
        Actor::Agent {
            name: self.agent.clone(),
        }
    }

    async fn render_tags(&self, text: &str) -> anyhow::Result<String> {
        let ids: std::collections::BTreeSet<_> = tessera_core::tag_tokens(text)
            .filter_map(|token| token.id)
            .collect();
        if ids.is_empty() {
            return Ok(text.to_owned());
        }
        let api = self.api().await?;
        let titles = crate::tag_titles(&api.client, &api.base, ids).await?;
        Ok(tessera_core::render_tags(text, |id| titles.get(id).map(String::as_str)).into_owned())
    }

    async fn api(&self) -> anyhow::Result<Api> {
        let (client, base) = service(self.notebook).await?;
        Ok(Api { client, base })
    }

    /// Commit one agent edit with the call's `reason`.
    async fn send(&self, arguments: &Value, edit: AgentEdit) -> anyhow::Result<AgentReceipt> {
        let request = AgentRequest {
            actor: self.actor(),
            reason: string(arguments, "reason")?.map(str::to_owned),
            edit,
        };
        self.api().await?.post("/api/agent-changes", &request).await
    }

    /// Commit one agent edit and describe its receipt.
    async fn submit(&self, arguments: &Value, edit: AgentEdit) -> anyhow::Result<String> {
        Ok(describe(&self.send(arguments, edit).await?))
    }
}

/// The change number, page, created pages and fields, and block revisions.
fn describe(receipt: &AgentReceipt) -> String {
    let mut text = format!("{}. This is change {}", receipt.summary, receipt.seq);
    if let Some(page) = &receipt.page {
        text.push_str(&format!(
            " on {} {:?} (id {})",
            kind_label(page.kind),
            page.text,
            page.id
        ));
    }
    text.push('.');
    if !receipt.created_pages.is_empty() {
        text.push_str(&format!(
            " Created atoms: {}.",
            quoted(&receipt.created_pages)
        ));
    }
    if !receipt.created_fields.is_empty() {
        text.push_str(&format!(
            " Created fields: {}.",
            quoted(&receipt.created_fields)
        ));
    }
    if !receipt.blocks.is_empty() {
        let blocks: Vec<_> = receipt
            .blocks
            .iter()
            .map(|block| format!("{} r{}", block.id, block.revision))
            .collect();
        text.push_str(&format!(" Atoms: {}.", blocks.join(", ")));
    }
    text
}

/// The service's loopback API for one tool call.
struct Api {
    client: reqwest::Client,
    base: String,
}

impl Api {
    async fn get<T: DeserializeOwned>(&self, path: &str) -> anyhow::Result<T> {
        self.get_with(path, &[]).await
    }

    async fn get_with<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> anyhow::Result<T> {
        let request = self.client.get(format!("{}{path}", self.base)).query(query);
        body(request.send().await?).await
    }

    async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &(impl Serialize + ?Sized),
    ) -> anyhow::Result<T> {
        let request = self.client.post(format!("{}{path}", self.base)).json(body);
        self::body(request.send().await?).await
    }
}

/// A successful response's JSON body, or the service's error message alone.
async fn body<T: DeserializeOwned>(response: reqwest::Response) -> anyhow::Result<T> {
    let status = response.status();
    if status.is_success() {
        return Ok(response.json().await?);
    }
    let text = response.text().await?;
    let error: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    match error["error"]["message"].as_str() {
        Some(message) => anyhow::bail!("{message}"),
        None => anyhow::bail!("Service returned {status}: {text}"),
    }
}

fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn failure(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// An optional string argument; present but not a string is an error.
fn string<'a>(arguments: &'a Value, key: &str) -> anyhow::Result<Option<&'a str>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => anyhow::bail!("{key} must be a string"),
    }
}

fn required(arguments: &Value, key: &str) -> anyhow::Result<String> {
    Ok(string(arguments, key)?
        .with_context(|| format!("{key} is required"))?
        .to_owned())
}

/// An optional integer argument; present but not an integer is an error.
fn integer(arguments: &Value, key: &str) -> anyhow::Result<Option<i64>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(
            value
                .as_i64()
                .with_context(|| format!("{key} must be an integer"))?,
        )),
    }
}

/// An optional boolean argument; present but not a boolean is an error.
fn boolean(arguments: &Value, key: &str) -> anyhow::Result<Option<bool>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => anyhow::bail!("{key} must be a boolean"),
    }
}

/// A count argument from 1 to `max`, `default` when absent.
fn limit(arguments: &Value, key: &str, default: usize, max: usize) -> anyhow::Result<usize> {
    match integer(arguments, key)? {
        None => Ok(default),
        Some(value) if value >= 1 && value as u64 <= max as u64 => Ok(value as usize),
        Some(_) => anyhow::bail!("{key} must be from 1 to {max}"),
    }
}

/// An optional array of strings; a single string counts as one item.
fn strings(arguments: &Value, key: &str) -> anyhow::Result<Vec<String>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(value)) => Ok(vec![value.clone()]),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .with_context(|| format!("{key} must hold strings"))
            })
            .collect(),
        Some(_) => anyhow::bail!("{key} must be an array of strings"),
    }
}

/// A snake_case enum value from a string argument, naming the choices on error.
fn choice<T: DeserializeOwned>(value: &str, key: &str, choices: &str) -> anyhow::Result<T> {
    serde_json::from_value(json!(value))
        .with_context(|| format!("{key} must be {choices}, not {value:?}"))
}

fn segment(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}
