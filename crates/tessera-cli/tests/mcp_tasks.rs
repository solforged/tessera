#![cfg(unix)]
//! `tessera mcp` task, relation and revisit tools against a running service.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::pin::Pin;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Keeps a process's data, state and cache under `home`.
fn isolate(command: &mut Command, home: &Path) {
    command
        .env("HOME", home)
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("XDG_STATE_HOME", home.join(".local/state"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env_remove("TESSERA_WORKSHOP");
}

/// `tessera serve` for one workshop, and a client for its loopback API.
struct Service {
    _process: ChildGuard,
    host: String,
    port: u16,
    client: reqwest::Client,
}

impl Service {
    fn start(home: &Path, workshop: &Path) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tessera"));
        isolate(&mut command, home);
        command
            .arg("--workshop")
            .arg(workshop)
            .args(["serve", "--port", "0", "--sync-port", "0"])
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut process = ChildGuard(command.spawn().unwrap());
        let mut stderr = BufReader::new(process.0.stderr.take().unwrap());
        let mut line = String::new();
        let host = loop {
            line.clear();
            assert_ne!(
                stderr.read_line(&mut line).unwrap(),
                0,
                "service exited before listening"
            );
            if line.contains("service listening") {
                break line.split_once("http://").unwrap().1.trim().to_owned();
            }
        };
        // Keep reading so the service never blocks on a full pipe.
        std::thread::spawn(move || stderr.lines().map_while(Result::ok).for_each(drop));
        let port = host.rsplit(':').next().unwrap().parse().unwrap();
        Self {
            _process: process,
            host,
            port,
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
        }
    }

    async fn get(&self, path: &str) -> Value {
        let response = self
            .client
            .get(format!("http://{}{path}", self.host))
            .send()
            .await
            .unwrap();
        assert!(
            response.status().is_success(),
            "{path}: {}",
            response.status()
        );
        response.json().await.unwrap()
    }

    /// The ID of the block on page `title` whose text contains `text`.
    async fn block(&self, title: &str, text: &str) -> String {
        let root = self.get(&format!("/api/pages/by-title/{title}")).await;
        let page = self
            .get(&format!("/api/pages/{}", root["id"].as_str().unwrap()))
            .await;
        let row = page["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["block"]["text"].as_str().unwrap().contains(text))
            .unwrap_or_else(|| panic!("no block reads {text:?} on {title}"));
        row["block"]["id"].as_str().unwrap().to_owned()
    }

    async fn task(&self, id: &str) -> Value {
        self.get(&format!("/api/blocks/{id}/capabilities"))
            .await
            .get("task")
            .cloned()
            .unwrap_or_default()
    }
}

/// A `tessera mcp` client on stdin and stdout.
struct Mcp {
    _process: ChildGuard,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Mcp {
    fn start(home: &Path, workshop: &Path) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tessera"));
        isolate(&mut command, home);
        command
            .arg("--workshop")
            .arg(workshop)
            .arg("mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut process = ChildGuard(command.spawn().unwrap());
        let stdin = process.0.stdin.take().unwrap();
        let stdout = BufReader::new(process.0.stdout.take().unwrap());
        let mut mcp = Self {
            _process: process,
            stdin,
            stdout,
        };
        let response = mcp.request(json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "clientInfo": { "name": "tasks" } },
        }));
        assert!(response["result"]["protocolVersion"].is_string());
        mcp
    }

    fn request(&mut self, request: Value) -> Value {
        let mut line = request.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).unwrap();
        self.stdin.flush().unwrap();
        line.clear();
        assert_ne!(
            self.stdout.read_line(&mut line).unwrap(),
            0,
            "the MCP server exited"
        );
        serde_json::from_str(&line).unwrap()
    }

    /// A tool's text and whether it reported an error.
    fn call(&mut self, tool: &str, arguments: Value) -> (String, bool) {
        let response = self.request(json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": tool, "arguments": arguments },
        }));
        let result = &response["result"];
        (
            result["content"][0]["text"].as_str().unwrap().to_owned(),
            result["isError"].as_bool().unwrap(),
        )
    }

    /// A tool's text, which must not be an error.
    fn text(&mut self, tool: &str, arguments: Value) -> String {
        let (text, error) = self.call(tool, arguments.clone());
        assert!(!error, "{tool} {arguments}: {text}");
        text
    }
}

type Hook = Arc<tokio::sync::Mutex<Option<Pin<Box<dyn Future<Output = ()> + Send>>>>>;

/// A loopback proxy to `upstream` that runs `hook` once, just before it
/// forwards the first agent change. Requests name the service's own address,
/// as it requires.
async fn proxy(upstream: u16, hook: Hook) -> u16 {
    const WRITE: &[u8] = b"POST /api/agent-changes ";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (ours, theirs) = (
        format!("127.0.0.1:{port}\r\n").into_bytes(),
        format!("127.0.0.1:{upstream}\r\n").into_bytes(),
    );
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let (hook, ours, theirs) = (hook.clone(), ours.clone(), theirs.clone());
            tokio::spawn(async move {
                let server = tokio::net::TcpStream::connect(("127.0.0.1", upstream))
                    .await
                    .unwrap();
                let (mut from_client, mut to_client) = client.into_split();
                let (mut from_server, mut to_server) = server.into_split();
                tokio::spawn(async move {
                    let _ = tokio::io::copy(&mut from_server, &mut to_client).await;
                });
                let mut buffer = vec![0; 64 * 1024];
                while let Ok(read @ 1..) = from_client.read(&mut buffer).await {
                    let mut bytes = buffer[..read].to_vec();
                    if let Some(at) = find(&bytes, &ours) {
                        bytes.splice(at..at + ours.len(), theirs.iter().copied());
                    }
                    if find(&bytes, WRITE).is_some()
                        && let Some(hook) = hook.lock().await.take()
                    {
                        hook.await;
                    }
                    if to_server.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    port
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_task_refuses_a_task_change_made_after_it_read_the_task() {
    let home = tempfile::tempdir().unwrap();
    let workshop = home.path().join("workshop");
    let service = Service::start(home.path(), &workshop);
    let mut mcp = Mcp::start(home.path(), &workshop);
    mcp.text(
        "tessera_add_note",
        json!({ "page": "Kitchen", "markdown": "- [ ] Pick the worktop sample" }),
    );
    let id = service.block("Kitchen", "worktop").await;

    // Someone else sets the priority after the MCP has read the task, before
    // its write arrives.
    let (client, host, other) = (service.client.clone(), service.host.clone(), id.clone());
    let hook: Hook = Arc::new(tokio::sync::Mutex::new(Some(Box::pin(async move {
        let caps: Value = client
            .get(format!("http://{host}/api/blocks/{other}/capabilities"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let mut task = caps["task"].clone();
        task["priority"] = json!("high");
        let response = client
            .post(format!("http://{host}/api/agent-changes"))
            .json(&json!({
                "actor": { "kind": "agent", "name": "other" },
                "kind": "set_task", "id": other, "task": task,
            }))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success(), "{}", response.status());
    }))));
    let port = proxy(service.port, hook.clone()).await;
    let lock = workshop.join("service.lock");
    let mut holder: Value = serde_json::from_slice(&std::fs::read(&lock).unwrap()).unwrap();
    holder["port"] = json!(port);
    std::fs::write(&lock, holder.to_string()).unwrap();

    let (text, error) = mcp.call(
        "tessera_set_task",
        json!({ "id": id, "scheduled": "2026-11-09" }),
    );
    assert!(
        hook.lock().await.is_none(),
        "the other change was made: {text}"
    );
    assert!(error, "the write over the other change was refused: {text}");
    let task = service.task(&id).await;
    assert_eq!(task["priority"], "high", "{task}");
    assert_eq!(task["scheduled"], Value::Null, "{task}");

    // Read again, the same call keeps both.
    mcp.text(
        "tessera_set_task",
        json!({ "id": id, "scheduled": "2026-11-09" }),
    );
    let task = service.task(&id).await;
    assert_eq!(
        (&task["priority"], &task["scheduled"]),
        (&json!("high"), &json!("2026-11-09")),
        "{task}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_relation_and_revisit_rows_are_lines_that_name_linked_pages() {
    let home = tempfile::tempdir().unwrap();
    let workshop = home.path().join("workshop");
    let service = Service::start(home.path(), &workshop);
    let mut mcp = Mcp::start(home.path(), &workshop);
    mcp.text(
        "tessera_add_note",
        json!({ "page": "Kitchen", "markdown": "- [ ] Call [[Priya Raman]] about the tiles\n\
            - [x] Measure the pantry wall\n\
            - Tiles outlast [[Paint]]\n\
            - Should the hall match [[Paint]]? #question" }),
    );
    let claim = service.block("Kitchen", "outlast").await;
    let question = service.block("Kitchen", "hall").await;
    mcp.text(
        "tessera_set_relation",
        json!({ "id": claim, "relation": "supports" }),
    );
    mcp.text(
        "tessera_revisit",
        json!({ "id": question, "action": "later", "next_on": "2020-01-01" }),
    );

    let tasks = mcp.text("tessera_tasks", json!({ "view": "list" }));
    assert!(
        tasks.contains("- [ ] Call [[Priya Raman]] about the tiles (block "),
        "{tasks}"
    );
    // Asking for done tasks lists them without include.
    let done = mcp.text(
        "tessera_tasks",
        json!({ "view": "list", "status": ["done"] }),
    );
    assert!(done.contains("[x] Measure the pantry wall"), "{done}");
    // Each view refuses the other's arguments instead of ignoring them.
    for arguments in [
        json!({ "status": ["done"] }),
        json!({ "days": 7, "limit": 1 }),
        json!({ "view": "list", "date": "today" }),
        json!({ "view": "list", "days": 7, "unplanned": true }),
    ] {
        let (text, error) = mcp.call("tessera_tasks", arguments.clone());
        assert!(error, "{arguments}: {text}");
    }

    let relations = mcp.text("tessera_relations", json!({ "kind": "supports" }));
    assert_eq!(relations.lines().count(), 2, "{relations}");
    assert!(relations.starts_with("1 of 1 relations:\n"), "{relations}");
    assert!(
        relations.contains("- supports “Tiles outlast [[Paint]]” (block ")
            && relations.contains("from atom \"Kitchen\"")
            && relations.contains("to atom \"Paint\""),
        "{relations}"
    );

    let revisits = mcp.text("tessera_revisits", json!({}));
    assert_eq!(revisits.lines().count(), 2, "{revisits}");
    assert!(
        revisits.contains("“Should the hall match [[Paint]]?")
            && revisits.contains("question open, due 2020-01-01"),
        "{revisits}"
    );

    for text in [&tasks, &done, &relations, &revisits] {
        assert!(!text.contains("[[01") && !text.contains('{'), "{text}");
    }
}
