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

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;

use anyhow::Context;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use tessera_core::{Actor, AgentEdit, AgentReceipt, AgentRequest, Block};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::{Service, service};
use render::{kind_label, quoted};

/// Newest first; the client's version is echoed when it is one of these.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// The one protocol version whose clients may send JSON-RPC batches.
const BATCH_VERSION: &str = "2025-03-26";

/// Attribution when the client gives no usable name.
const DEFAULT_AGENT: &str = "mcp";

/// The longest client name kept for attribution, in characters.
const AGENT_NAME_CHARS: usize = 64;

/// How many block revisions a receipt lists before counting the rest.
const RECEIPT_BLOCKS: usize = 50;

const INSTRUCTIONS: &str = "Tessera is a local outline workshop. Every note is a tree of \
blocks on a named page or a journal day. Search or read before writing to avoid duplicates. \
tessera_add_note appends to the end of a page, journal day or block; tessera_edit_block, \
tessera_move_block, tessera_delete_block, tessera_set_task and tessera_set_relation change existing blocks by the \
IDs tessera_read_page shows. Flashcards, tasks and field entries are written as block text \
(see tessera_add_note); tessera_cards, tessera_tasks and tessera_query read them back, and \
tessera_hold_card suspends a card; tessera_save_deck groups cards into decks. \
tessera_relations reads explicitly authored supports, disputes, qualifies and answers relations. \
tessera_revisits reads questions and notes due for another look, and tessera_revisit records, \
moves, resolves or reopens a revisit. \
tessera_library reads books and articles and tessera_cite links blocks to their passages. \
tessera_sync tells whether your edits have reached the workshop's hub. Every write is one \
change attributed to you and can be reversed with tessera_undo; tessera_recent_changes lists \
the workshop history.";

pub async fn serve(notebook: &Path) -> anyhow::Result<()> {
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).split(b'\n');
    let mut stdout = tokio::io::stdout();
    let mut session = Session::new(notebook);
    while let Some(line) = lines.next_segment().await? {
        let Some(response) = session.line(&line).await else {
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
    /// The protocol version `initialize` settled on.
    version: Option<&'static str>,
    /// The notebook ID the first tool call reached. The change numbers and IDs
    /// handed out since belong to it, so no later call may reach another.
    identity: OnceLock<String>,
    /// The current tool call's API, resolved on first use.
    api: tokio::sync::OnceCell<Api>,
}

impl<'a> Session<'a> {
    fn new(notebook: &'a Path) -> Self {
        Self {
            notebook,
            agent: DEFAULT_AGENT.into(),
            version: None,
            identity: OnceLock::new(),
            api: tokio::sync::OnceCell::new(),
        }
    }
}

impl Session<'_> {
    /// The response to one line of input; blank lines, notifications and the
    /// client's responses get none.
    async fn line(&mut self, line: &[u8]) -> Option<Value> {
        let Ok(line) = std::str::from_utf8(line) else {
            return Some(failure(
                Value::Null,
                -32700,
                "Parse error: the message is not valid UTF-8.",
            ));
        };
        if line.trim().is_empty() {
            return None;
        }
        match serde_json::from_str(line) {
            Ok(Value::Array(batch)) => self.batch(batch).await,
            Ok(message) => self.message(message).await,
            Err(error) => Some(failure(Value::Null, -32700, &error.to_string())),
        }
    }

    /// A JSON-RPC batch, which only protocol version 2025-03-26 has. Its
    /// responses come back as one array; a batch of notifications gets none.
    async fn batch(&mut self, batch: Vec<Value>) -> Option<Value> {
        if self.version != Some(BATCH_VERSION) {
            return Some(failure(
                Value::Null,
                -32600,
                &format!(
                    "Batches need protocol version {BATCH_VERSION}; send one message per line."
                ),
            ));
        }
        if batch.is_empty() {
            return Some(failure(
                Value::Null,
                -32600,
                "A batch needs at least one message.",
            ));
        }
        let mut responses = Vec::new();
        for message in batch {
            if message.get("method").and_then(Value::as_str) == Some("initialize") {
                let id = message.get("id").filter(|id| valid_id(id)).cloned();
                responses.push(failure(
                    id.unwrap_or_default(),
                    -32600,
                    "initialize cannot be part of a batch.",
                ));
                continue;
            }
            responses.extend(self.message(message).await);
        }
        (!responses.is_empty()).then_some(Value::Array(responses))
    }

    /// The response to one message; notifications and the client's responses get none.
    async fn message(&mut self, message: Value) -> Option<Value> {
        let Value::Object(mut message) = message else {
            return Some(failure(
                Value::Null,
                -32600,
                "A message must be a JSON object.",
            ));
        };
        let id = message.remove("id");
        let Some(method) = message.remove("method") else {
            if message.contains_key("result") || message.contains_key("error") {
                return None;
            }
            let id = id.filter(valid_id).unwrap_or_default();
            return Some(failure(id, -32600, "A request needs a method."));
        };
        let id = match id {
            None => return None,
            Some(id) if valid_id(&id) => id,
            Some(_) => {
                return Some(failure(
                    Value::Null,
                    -32600,
                    "id must be a string or an integer.",
                ));
            }
        };
        if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Some(failure(id, -32600, "jsonrpc must be \"2.0\"."));
        }
        let Value::String(method) = method else {
            return Some(failure(id, -32600, "method must be a string."));
        };
        let params = match message.remove("params") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(params)) => params,
            Some(_) => return Some(failure(id, -32602, "params must be an object.")),
        };
        Some(match method.as_str() {
            "initialize" => {
                if let Some(name) = params
                    .get("clientInfo")
                    .and_then(|info| info.get("name"))
                    .and_then(Value::as_str)
                {
                    self.agent = agent_name(name);
                }
                let version = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .and_then(|version| PROTOCOL_VERSIONS.into_iter().find(|v| *v == version))
                    .unwrap_or(PROTOCOL_VERSIONS[0]);
                self.version = Some(version);
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
            "tools/call" => self.call(id, params).await,
            _ => failure(id, -32601, &format!("Method not found: {method}")),
        })
    }

    /// One tool call. A malformed call is a JSON-RPC error; a tool's own
    /// failure is a result with `isError`.
    async fn call(&mut self, id: Value, mut params: Map<String, Value>) -> Value {
        let name = match params.remove("name") {
            Some(Value::String(name)) => name,
            Some(_) => return failure(id, -32602, "params.name must be a string."),
            None => return failure(id, -32602, "params.name is required."),
        };
        let arguments = match params.remove("arguments") {
            None | Some(Value::Null) => Value::Object(Map::new()),
            Some(arguments @ Value::Object(_)) => arguments,
            Some(_) => return failure(id, -32602, "arguments must be an object."),
        };
        let Some(result) = self.tool(&name, &arguments).await else {
            return failure(id, -32602, &format!("Unknown tool: {name}"));
        };
        let (text, error) = match result {
            Ok(text) => (text, false),
            Err(error) => (format!("{error:#}"), true),
        };
        // The next call resolves the service afresh.
        self.api.take();
        success(
            id,
            json!({ "content": [{ "type": "text", "text": text }], "isError": error }),
        )
    }

    /// The named tool's result, or `None` when no tool has that name. An
    /// argument its schema does not declare is refused before it runs.
    async fn tool(&self, name: &str, arguments: &Value) -> Option<anyhow::Result<String>> {
        if let Err(error) = undeclared(name, tools::arguments(name)?, arguments) {
            return Some(Err(error));
        }
        Some(match name {
            "tessera_search" => self.search(arguments).await,
            "tessera_list_pages" => self.list_pages(arguments).await,
            "tessera_read_page" => self.read_page(arguments).await,
            "tessera_add_note" => self.add_note(arguments).await,
            "tessera_edit_block" => self.edit_block(arguments).await,
            "tessera_move_block" => self.move_block(arguments).await,
            "tessera_delete_block" => self.delete_block(arguments).await,
            "tessera_set_task" => self.set_task(arguments).await,
            "tessera_set_relation" => self.set_relation(arguments).await,
            "tessera_relations" => self.relations(arguments).await,
            "tessera_revisits" => self.revisits(arguments).await,
            "tessera_revisit" => self.revisit(arguments).await,
            "tessera_tasks" => self.tasks(arguments).await,
            "tessera_cards" => self.cards(arguments).await,
            "tessera_hold_card" => self.hold_card(arguments).await,
            "tessera_query" => self.query(arguments).await,
            "tessera_library" => self.library(arguments).await,
            "tessera_cite" => self.cite(arguments).await,
            "tessera_recent_changes" => self.recent_changes(arguments).await,
            "tessera_sync" => self.sync(arguments).await,
            "tessera_save_deck" => self.save_deck(arguments).await,
            "tessera_undo" => self.undo(arguments).await,
            _ => return None,
        })
    }

    fn actor(&self) -> Actor {
        Actor::Agent {
            name: self.agent.clone(),
        }
    }

    /// The receipt of a committed change, its texts shown by title. A failed
    /// lookup leaves their IDs, because the change itself succeeded.
    async fn describe(&self, receipt: &AgentReceipt) -> String {
        let texts = [&receipt.summary]
            .into_iter()
            .chain(receipt.page.iter().map(|page| &page.text))
            .chain(receipt.created_pages.iter().map(|page| &page.text))
            .chain(receipt.created_fields.iter().map(|field| &field.text))
            .map(String::as_str);
        let titles = match self.api().await {
            Ok(api) => Titles::lenient(&api, texts).await,
            Err(_) => Titles(HashMap::new()),
        };
        describe(receipt, &titles)
    }

    /// The service's API for the current tool call. The first use resolves it
    /// and later uses share it, so one call never spans two workshops.
    async fn api(&self) -> anyhow::Result<Api> {
        let api = self
            .api
            .get_or_try_init(|| async {
                let service = service(self.notebook).await?;
                let first = self.identity.get_or_init(|| service.id.to_string());
                anyhow::ensure!(
                    first.as_str() == &*service.id,
                    "{} now holds notebook {}, not notebook {first} that this MCP server started with. \
                     Restart the server to work in it; the change numbers and IDs it gave out belong to the old one.",
                    self.notebook.display(),
                    service.id
                );
                Ok(Api(service))
            })
            .await?;
        Ok(api.clone())
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
        let receipt = self.send(arguments, edit).await?;
        Ok(self.describe(&receipt).await)
    }
}

/// Whether a JSON-RPC id is one MCP allows: a string or an integer, never null.
fn valid_id(id: &Value) -> bool {
    match id {
        Value::String(_) => true,
        Value::Number(number) => number.is_i64() || number.is_u64(),
        _ => false,
    }
}

/// A client's `clientInfo.name` made fit for one line of history: control
/// characters and runs of whitespace become one space, and the length is
/// capped. A blank name falls back to `mcp`.
fn agent_name(name: &str) -> String {
    let mut agent = String::new();
    for word in name
        .split(|ch: char| ch.is_whitespace() || ch.is_control())
        .filter(|word| !word.is_empty())
    {
        if !agent.is_empty() {
            agent.push(' ');
        }
        agent.push_str(word);
    }
    if let Some((end, _)) = agent.char_indices().nth(AGENT_NAME_CHARS) {
        agent.truncate(end);
        agent.truncate(agent.trim_end().len());
    }
    if agent.is_empty() {
        DEFAULT_AGENT.into()
    } else {
        agent
    }
}

/// The change number, page, created pages and fields, and block revisions,
/// with their texts shown by title.
fn describe(receipt: &AgentReceipt, titles: &Titles) -> String {
    let mut text = format!(
        "{}. This is change {}",
        titles.show(&receipt.summary),
        receipt.seq
    );
    if let Some(page) = &receipt.page {
        text.push_str(&format!(
            " on {} {:?} (id {})",
            kind_label(page.kind),
            titles.show(&page.text),
            page.id
        ));
    }
    text.push('.');
    if !receipt.created_pages.is_empty() {
        text.push_str(&format!(
            " Created atoms: {}.",
            quoted(&titles.blocks(&receipt.created_pages))
        ));
    }
    if !receipt.created_fields.is_empty() {
        text.push_str(&format!(
            " Created fields: {}.",
            quoted(&titles.blocks(&receipt.created_fields))
        ));
    }
    if !receipt.blocks.is_empty() {
        let blocks: Vec<_> = receipt
            .blocks
            .iter()
            .take(RECEIPT_BLOCKS)
            .map(|block| format!("{} r{}", block.id, block.revision))
            .collect();
        text.push_str(&format!(" Atoms: {}", blocks.join(", ")));
        match receipt.blocks.len() - blocks.len() {
            0 => text.push('.'),
            more => text.push_str(&format!(
                " and {more} more; tessera_read_page shows every ID and revision."
            )),
        }
    }
    text
}

/// Live titles for the `[[ID]]` references and `#[[ID|…]]` tags in some block
/// texts, so a tool prints them by name, as tessera_read_page does.
struct Titles(HashMap<String, String>);

impl Titles {
    /// The titles of every page and journal day the texts name. A target that
    /// no longer exists keeps its ID; any other failed lookup is an error, which
    /// a caller may answer by printing the raw text.
    async fn load<'a>(api: &Api, texts: impl IntoIterator<Item = &'a str>) -> anyhow::Result<Self> {
        let ids: HashSet<&str> = texts.into_iter().flat_map(Self::targets).collect();
        Ok(Self(api.0.titles(ids).await?))
    }

    /// [`Titles::load`], except that when the titles cannot be read the texts
    /// keep their IDs, for output that must not fail on them.
    async fn lenient<'a>(api: &Api, texts: impl IntoIterator<Item = &'a str>) -> Self {
        Self::load(api, texts)
            .await
            .unwrap_or_else(|_| Self(HashMap::new()))
    }

    /// `text` with its references and tags shown by title.
    fn show(&self, text: &str) -> String {
        let titles: HashMap<&str, &str> = Self::targets(text)
            .filter_map(|id| self.0.get_key_value(id))
            .map(|(id, title)| (id.as_str(), title.as_str()))
            .collect();
        render::titled(text, &titles)
    }

    /// A block, typically a page, with its text shown by title.
    fn block(&self, block: &Block) -> Block {
        Block {
            text: self.show(&block.text),
            ..block.clone()
        }
    }

    /// [`Titles::block`] for each block.
    fn blocks(&self, blocks: &[Block]) -> Vec<Block> {
        blocks.iter().map(|block| self.block(block)).collect()
    }

    /// The IDs a text's `[[ID]]` references and canonical tags name.
    fn targets(text: &str) -> impl Iterator<Item = &str> {
        tessera_core::reference_spans(text)
            .filter(move |(span, _, _)| text[span.clone()].starts_with("[["))
            .map(|(_, target, _)| target)
            .chain(tessera_core::tag_tokens(text).filter_map(|token| token.id))
    }
}

/// The service's loopback API for one tool call, bound to one workshop.
#[derive(Clone)]
struct Api(Service);

impl Api {
    async fn get<T: DeserializeOwned>(&self, path: &str) -> anyhow::Result<T> {
        self.get_with(path, &[]).await
    }

    async fn get_with<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> anyhow::Result<T> {
        let request = self.0.request(reqwest::Method::GET, path).query(query);
        body(request.send().await?).await
    }

    async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &(impl Serialize + ?Sized),
    ) -> anyhow::Result<T> {
        let request = self.0.request(reqwest::Method::POST, path).json(body);
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
    match (
        error["error"]["code"].as_str(),
        error["error"]["message"].as_str(),
    ) {
        (Some("notebook_changed"), Some(message)) => anyhow::bail!(
            "{message} The request was refused and changed nothing: this MCP server stays with \
             the workshop it started with. Switch the service back to it, or restart the server."
        ),
        (_, Some(message)) => anyhow::bail!("{message}"),
        (_, None) => anyhow::bail!("Service returned {status}: {text}"),
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

/// An optional integer argument; present but not an integer is an error. A
/// number with no fractional part counts, as it does in JSON Schema.
fn integer(arguments: &Value, key: &str) -> anyhow::Result<Option<i64>> {
    // 2^63, the first float past `i64::MAX`.
    const END: f64 = -(i64::MIN as f64);
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(
            value
                .as_i64()
                .or_else(|| {
                    value
                        .as_f64()
                        .filter(|number| number.fract() == 0.0 && (-END..END).contains(number))
                        .map(|number| number as i64)
                })
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

/// An optional `offset` argument, how many rows to skip: 0 or more.
fn offset(arguments: &Value) -> anyhow::Result<Option<usize>> {
    integer(arguments, "offset")?
        .map(|offset| {
            usize::try_from(offset)
                .ok()
                .context("offset must be 0 or more")
        })
        .transpose()
}

/// Refuses the arguments `tool` does not declare, which it would otherwise
/// ignore, naming those it takes.
fn undeclared(tool: &str, declared: &Map<String, Value>, arguments: &Value) -> anyhow::Result<()> {
    let unknown: Vec<&str> = arguments
        .as_object()
        .into_iter()
        .flat_map(Map::keys)
        .map(String::as_str)
        .filter(|key| !declared.contains_key(*key))
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    let takes: Vec<&str> = declared.keys().map(String::as_str).collect();
    anyhow::bail!(
        "{tool} does not take {}; it takes {}.",
        listed(&unknown),
        listed(&takes)
    )
}

/// Names joined as prose: "a", "a and b", "a, b and c".
fn listed(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [only] => (*only).to_owned(),
        [first @ .., last] => format!("{} and {last}", first.join(", ")),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A session whose workshop has no service, so a tool that runs fails.
    fn session() -> Session<'static> {
        Session::new(Path::new("/nonexistent/tessera-mcp-test"))
    }

    async fn send(session: &mut Session<'_>, line: &str) -> Option<Value> {
        session.line(line.as_bytes()).await
    }

    async fn initialize(session: &mut Session<'_>, version: &str) {
        let line = json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": { "protocolVersion": version, "clientInfo": { "name": "test" } },
        });
        let response = send(session, &line.to_string()).await.unwrap();
        assert_eq!(response["result"]["protocolVersion"], version);
    }

    /// The error's id and code, asserting the message has no result.
    fn error(response: &Value) -> (Value, i64) {
        assert!(response.get("result").is_none(), "{response}");
        (
            response["id"].clone(),
            response["error"]["code"].as_i64().unwrap(),
        )
    }

    #[tokio::test]
    async fn invalid_messages_get_errors_and_the_session_keeps_serving() {
        let mut session = session();
        for line in [
            "42",
            "{}",
            r#"{"jsonrpc":"2.0","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":1.5,"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":true,"method":"ping"}"#,
        ] {
            let response = send(&mut session, line).await.unwrap();
            assert_eq!(error(&response), (Value::Null, -32600), "{line}");
        }
        for line in [
            r#"{"jsonrpc":"1.0","id":7,"method":"ping"}"#,
            r#"{"id":7,"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":7,"method":5}"#,
        ] {
            let response = send(&mut session, line).await.unwrap();
            assert_eq!(error(&response), (json!(7), -32600), "{line}");
        }
        let response = session
            .line(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\",\"x\":\"\xff\xfe\"}")
            .await
            .unwrap();
        assert_eq!(error(&response), (Value::Null, -32700));
        // Notifications and the client's own responses get no answer.
        for line in [
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            r#"{"jsonrpc":"2.0","id":3,"result":{}}"#,
            "   ",
        ] {
            assert_eq!(send(&mut session, line).await, None, "{line}");
        }
        let pong = send(
            &mut session,
            r#"{"jsonrpc":"2.0","id":"p","method":"ping"}"#,
        )
        .await
        .unwrap();
        assert_eq!(pong["id"], "p");
        assert_eq!(pong["result"], json!({}));
    }

    /// A receipt whose summary, page and created page carry a tag.
    fn tagged_receipt() -> AgentReceipt {
        let tag = "01J0000000000000000000000B";
        let page = json!({
            "id": "01J0000000000000000000000A", "kind": "page", "parent_id": null,
            "page_id": "01J0000000000000000000000A", "text": format!("Babbage #[[{tag}|person]]"),
            "heading": null, "archived": false, "revision": 1, "created_at": 0, "updated_at": 0,
        });
        serde_json::from_value(json!({
            "seq": 9, "summary": format!("Added 1 atom to “Babbage #[[{tag}|person]]”"),
            "page": page, "blocks": [], "created_pages": [page],
            "committed": { "seq": 9, "revisions": [], "deletions": [], "replayed": false },
        }))
        .unwrap()
    }

    #[test]
    fn receipts_show_their_texts_by_title() {
        let titles = Titles(HashMap::from([(
            "01J0000000000000000000000B".to_owned(),
            "Person".to_owned(),
        )]));
        assert_eq!(
            describe(&tagged_receipt(), &titles),
            "Added 1 atom to “Babbage #Person”. This is change 9 on atom \"Babbage #Person\" \
             (id 01J0000000000000000000000A). Created atoms: \"Babbage #Person\"."
        );
    }

    #[tokio::test]
    async fn a_failed_tag_lookup_keeps_the_successful_output() {
        let receipt = tagged_receipt();
        assert_eq!(
            session().describe(&receipt).await,
            describe(&receipt, &Titles(HashMap::new()))
        );
    }

    #[tokio::test]
    async fn a_null_id_never_runs_a_tool() {
        let mut session = session();
        let line = json!({
            "jsonrpc": "2.0", "id": null, "method": "tools/call",
            "params": { "name": "tessera_search", "arguments": { "query": "x" } },
        });
        let response = send(&mut session, &line.to_string()).await.unwrap();
        assert_eq!(error(&response), (Value::Null, -32600));
    }

    #[tokio::test]
    async fn batches_run_only_under_the_version_that_has_them() {
        let mut session = session();
        let pings = r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]"#;
        let refused = send(&mut session, pings).await.unwrap();
        assert_eq!(error(&refused), (Value::Null, -32600));
        initialize(&mut session, "2025-06-18").await;
        let refused = send(&mut session, pings).await.unwrap();
        assert_eq!(error(&refused), (Value::Null, -32600));

        initialize(&mut session, BATCH_VERSION).await;
        let answered = send(&mut session, pings).await.unwrap();
        let ids: Vec<&Value> = answered
            .as_array()
            .unwrap()
            .iter()
            .map(|response| &response["id"])
            .collect();
        assert_eq!(ids, [&json!(1), &json!(2)]);
        assert!(
            answered
                .as_array()
                .unwrap()
                .iter()
                .all(|response| response["result"] == json!({}))
        );
        let empty = send(&mut session, "[]").await.unwrap();
        assert_eq!(error(&empty), (Value::Null, -32600));
        let mixed = send(
            &mut session,
            r#"[42,{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":4,"method":"initialize","params":{}}]"#,
        )
        .await
        .unwrap();
        let mixed = mixed.as_array().unwrap();
        assert_eq!(mixed.len(), 2);
        assert_eq!(error(&mixed[0]), (Value::Null, -32600));
        assert_eq!(error(&mixed[1]), (json!(4), -32600));
        assert_eq!(
            session.version,
            Some(BATCH_VERSION),
            "a batched initialize must not renegotiate"
        );
        let notifications = r#"[{"jsonrpc":"2.0","method":"notifications/initialized"}]"#;
        assert_eq!(send(&mut session, notifications).await, None);
    }

    #[tokio::test]
    async fn tool_calls_need_a_name_and_object_arguments() {
        let mut session = session();
        for params in [
            None,
            Some(json!(["tessera_search"])),
            Some(json!({ "arguments": {} })),
            Some(json!({ "name": 5 })),
            Some(json!({ "name": "tessera_list_pages", "arguments": "limit=1" })),
            Some(json!({ "name": "tessera_nothing" })),
        ] {
            let mut line = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call" });
            if let Some(params) = &params {
                line["params"] = params.clone();
            }
            let response = send(&mut session, &line.to_string()).await.unwrap();
            assert_eq!(error(&response), (json!(1), -32602), "{params:?}");
        }
        // A well-formed call reaches the tool, which reports its own failure.
        let line = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "tessera_list_pages" },
        });
        let response = send(&mut session, &line.to_string()).await.unwrap();
        assert_eq!(response["result"]["isError"], true);
    }

    /// A tool call's text and whether it reported an error.
    async fn call(session: &mut Session<'_>, name: &str, arguments: Value) -> (String, bool) {
        let line = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        });
        let response = send(session, &line.to_string()).await.unwrap();
        let result = &response["result"];
        assert!(result.is_object(), "{name}: {response}");
        (
            result["content"][0]["text"].as_str().unwrap().to_owned(),
            result["isError"].as_bool().unwrap(),
        )
    }

    #[tokio::test]
    async fn undeclared_arguments_are_refused_before_the_tool_runs() {
        let mut session = session();
        for (name, arguments, refusal) in [
            (
                "tessera_list_pages",
                json!({ "limit": 2, "bogus": 1 }),
                "tessera_list_pages does not take bogus; it takes journals, limit and offset.",
            ),
            (
                "tessera_read_page",
                json!({ "title": "Choice repro paper", "bogus": 1 }),
                "tessera_read_page does not take bogus; it takes date, id, subtree and title.",
            ),
            (
                "tessera_search",
                json!({ "query": "paper", "limit": 1, "offset": 5 }),
                "tessera_search does not take offset; it takes limit and query.",
            ),
            (
                "tessera_recent_changes",
                json!({ "limit": 1, "offset": 5, "after": null }),
                "tessera_recent_changes does not take after and offset; it takes before and limit.",
            ),
            (
                "tessera_query",
                json!({ "source": "sources", "limit": 1, "bogus": 1 }),
                "tessera_query does not take bogus; it takes direction, filters, limit, offset, \
                 sort, source, text, type and view.",
            ),
            (
                "tessera_tasks",
                json!({ "view": "list", "days": 7, "unplanned": false }),
                "The task list does not take these agenda arguments: days, unplanned. Pass view \
                 agenda to use them, or leave them out.",
            ),
        ] {
            assert_eq!(
                call(&mut session, name, arguments).await,
                (refusal.to_owned(), true)
            );
        }
        // Declared arguments reach the tool, which fails here for want of a service.
        let (text, error) = call(&mut session, "tessera_list_pages", json!({ "offset": 0 })).await;
        assert!(error && !text.contains("does not take"), "{text}");
    }

    #[tokio::test]
    async fn every_listed_tool_runs_and_declares_its_arguments() {
        let mut session = session();
        let tools = tools::tools().as_array().unwrap();
        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            assert!(tools::arguments(name).is_some(), "{name}");
            // No service answers, so each tool reports its own failure.
            let (text, error) = call(&mut session, name, json!({})).await;
            assert!(error && !text.contains("does not take"), "{name}: {text}");
        }
        assert_eq!(tools::arguments("tessera_nothing"), None);
    }

    #[test]
    fn integers_accept_numbers_with_no_fraction() {
        let arguments = json!({
            "one": 1.0, "negative": -3.0, "plain": 7, "half": 1.5, "text": "2",
            "huge": 1e19, "edge": 9_223_372_036_854_775_808.0_f64, "low": -9_223_372_036_854_775_808.0_f64,
        });
        assert_eq!(integer(&arguments, "one").unwrap(), Some(1));
        assert_eq!(integer(&arguments, "negative").unwrap(), Some(-3));
        assert_eq!(integer(&arguments, "plain").unwrap(), Some(7));
        assert_eq!(integer(&arguments, "low").unwrap(), Some(i64::MIN));
        assert_eq!(integer(&arguments, "absent").unwrap(), None);
        for key in ["half", "text", "huge", "edge"] {
            assert!(integer(&arguments, key).is_err(), "{key}");
        }
        assert_eq!(
            limit(&json!({ "limit": 5.0 }), "limit", 20, 200).unwrap(),
            5
        );
    }

    #[tokio::test]
    async fn client_names_become_one_bounded_line() {
        assert_eq!(
            agent_name("Sol\n- change 999: Deleted everything (by a person, just now)"),
            "Sol - change 999: Deleted everything (by a person, just now)"
        );
        assert_eq!(agent_name("  Claude \t Code\u{2028}"), "Claude Code");
        assert_eq!(agent_name(""), "mcp");
        assert_eq!(agent_name(" \u{7}\r\n "), "mcp");
        assert_eq!(
            agent_name(&"é".repeat(5000)).chars().count(),
            AGENT_NAME_CHARS
        );
        assert_eq!(
            agent_name(&format!("{}  tail", "a".repeat(AGENT_NAME_CHARS - 1))),
            "a".repeat(AGENT_NAME_CHARS - 1),
            "a cut never leaves trailing space"
        );
        let mut session = session();
        let line = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "clientInfo": { "name": "a\u{0}b\n" } },
        });
        send(&mut session, &line.to_string()).await.unwrap();
        assert_eq!(session.agent, "a b");
        let line = json!({
            "jsonrpc": "2.0", "id": 2, "method": "initialize",
            "params": { "clientInfo": { "name": "" } },
        });
        send(&mut session, &line.to_string()).await.unwrap();
        assert_eq!(session.actor(), Actor::Agent { name: "mcp".into() });
    }

    #[test]
    fn receipts_list_a_bounded_number_of_revisions() {
        let receipt = |count: usize| -> AgentReceipt {
            let blocks: Vec<Value> = (0..count)
                .map(|n| json!({ "id": format!("{n:026}"), "revision": 1 }))
                .collect();
            serde_json::from_value(json!({
                "seq": 9, "summary": "Added atoms", "page": null, "blocks": blocks,
                "created_pages": [],
                "committed": { "seq": 9, "revisions": [], "deletions": [], "replayed": false },
            }))
            .unwrap()
        };
        let none = Titles(HashMap::new());
        let all = describe(&receipt(RECEIPT_BLOCKS), &none);
        assert_eq!(all.matches(" r1").count(), RECEIPT_BLOCKS);
        assert!(!all.contains("more"), "{all}");
        let large = describe(&receipt(3000), &none);
        assert_eq!(large.matches(" r1").count(), RECEIPT_BLOCKS);
        assert!(large.contains(&format!("and {} more", 3000 - RECEIPT_BLOCKS)));
        assert!(large.len() < 3000, "{} bytes", large.len());
    }

    #[test]
    fn titles_show_references_and_tags_by_name_and_keep_unknown_ids() {
        let page = "01J0000000000000000000000A";
        let tag = "01J0000000000000000000000B";
        let gone = "01J0000000000000000000000C";
        let text = format!(
            "see [[{page}]] and [[{page}|it]], #[[{tag}|Old]], [[{gone}]] and `[[{page}]]`"
        );
        // The reference inside the code span is literal text.
        let mut targets: Vec<&str> = Titles::targets(&text).collect();
        targets.sort_unstable();
        assert_eq!(targets, [page, page, tag, gone]);
        let titles = Titles(HashMap::from([
            (page.to_owned(), "Dune".to_owned()),
            (tag.to_owned(), "Marine".to_owned()),
        ]));
        assert_eq!(
            titles.show(&text),
            format!("see [[Dune]] and [[Dune|it]], #Marine, [[{gone}]] and `[[{page}]]`")
        );
    }
}
