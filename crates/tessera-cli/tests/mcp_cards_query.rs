#![cfg(unix)]

//! `tessera mcp`'s card, deck and query tools against a running service.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// `tessera` with its home, data, state and cache under `home`.
fn tessera(home: &Path, workshop: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tessera"));
    command
        .env("HOME", home)
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("XDG_STATE_HOME", home.join(".local/state"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env_remove("TESSERA_WORKSHOP")
        .arg("--workshop")
        .arg(workshop);
    for key in ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
        command.env_remove(key);
    }
    command
}

/// A served workshop and an MCP session on it.
struct Workshop {
    mcp: ChildGuard,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    _service: ChildGuard,
    _stderr: BufReader<ChildStderr>,
    _root: tempfile::TempDir,
}

impl Workshop {
    fn start() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(root.path()).unwrap();
        let workshop = home.join("workshop");
        let mut service = ChildGuard(
            tessera(&home, &workshop)
                .args(["serve", "--port", "0", "--sync-port", "0"])
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut stderr = BufReader::new(service.0.stderr.take().unwrap());
        let mut line = String::new();
        while !line.contains("service listening") {
            line.clear();
            assert_ne!(stderr.read_line(&mut line).unwrap(), 0, "service exited");
        }
        let mut mcp = ChildGuard(
            tessera(&home, &workshop)
                .arg("mcp")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let stdin = mcp.0.stdin.take().unwrap();
        let stdout = BufReader::new(mcp.0.stdout.take().unwrap());
        let mut workshop = Self {
            mcp,
            stdin,
            stdout,
            _service: service,
            _stderr: stderr,
            _root: root,
        };
        let response = workshop.send(json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "clientInfo": { "name": "cards" } },
        }));
        assert!(response["result"]["protocolVersion"].is_string());
        workshop
    }

    fn send(&mut self, message: Value) -> Value {
        writeln!(self.stdin, "{message}").unwrap();
        self.stdin.flush().unwrap();
        let mut line = String::new();
        assert_ne!(
            self.stdout.read_line(&mut line).unwrap(),
            0,
            "the MCP server exited: {:?}",
            self.mcp.0.try_wait()
        );
        serde_json::from_str(&line).unwrap()
    }

    /// A tool's text and whether it reported an error.
    fn call(&mut self, tool: &str, arguments: Value) -> (String, bool) {
        let response = self.send(json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": tool, "arguments": arguments },
        }));
        let result = &response["result"];
        (
            result["content"][0]["text"].as_str().unwrap().to_owned(),
            result["isError"].as_bool().unwrap(),
        )
    }

    /// A successful tool's text.
    fn ok(&mut self, tool: &str, arguments: Value) -> String {
        let (text, error) = self.call(tool, arguments.clone());
        assert!(!error, "{tool} {arguments}: {text}");
        text
    }

    /// A failed tool's text.
    fn refused(&mut self, tool: &str, arguments: Value) -> String {
        let (text, error) = self.call(tool, arguments.clone());
        assert!(error, "{tool} {arguments} succeeded: {text}");
        text
    }
}

/// The `(id ID)` a receipt names its page by.
fn page_id(receipt: &str) -> &str {
    let start = receipt.find("(id ").expect(receipt) + 4;
    &receipt[start..start + 26]
}

#[test]
fn cards_read_journal_days_decks_and_tag_decks_by_any_name() {
    let mut workshop = Workshop::start();
    workshop.ok(
        "tessera_add_note",
        json!({
            "page": "Italian",
            "markdown": "- lavello >> sink #italian\n- tavolo >> table #italian\n- Who tiles for [[Hana Okafor]]? >> Hana #italian",
        }),
    );
    let day = workshop.ok(
        "tessera_add_note",
        json!({ "markdown": "- Capital of Peru >> Lima" }),
    );
    let date = day.split("journal day \"").nth(1).expect(&day)[..10].to_owned();
    let day_id = page_id(&day).to_owned();

    // A page is today, a date, a page or journal day's ID, or a title.
    for page in ["today", date.as_str(), day_id.as_str()] {
        let cards = workshop.ok("tessera_cards", json!({ "page": page }));
        assert!(cards.contains("Capital of Peru → Lima"), "{page}: {cards}");
    }
    let italian = workshop.ok("tessera_cards", json!({ "page": "Italian" }));
    assert!(
        italian.contains("Who tiles for [[Hana Okafor]]? → Hana"),
        "{italian}"
    );
    let block = italian
        .lines()
        .find(|line| line.contains("lavello"))
        .and_then(|line| line.rsplit("(block ").next())
        .map(|id| id.trim_end_matches(')').to_owned())
        .unwrap();
    let inside = workshop.refused("tessera_cards", json!({ "page": block }));
    assert!(inside.contains("block_id"), "{inside}");
    let ignored = workshop.refused(
        "tessera_cards",
        json!({ "page": "Italian", "selection": "all" }),
    );
    assert!(ignored.contains("selection"), "{ignored}");

    // A deck reviews its own selection unless the call names one.
    workshop.ok(
        "tessera_save_deck",
        json!({ "name": "New Italian", "type": "italian", "selection": "new" }),
    );
    let queue = workshop.ok("tessera_cards", json!({ "deck": "new italian" }));
    assert!(queue.starts_with("3 of 3 new cards:"), "{queue}");
    let all = workshop.ok(
        "tessera_cards",
        json!({ "deck": "New Italian", "selection": "all", "limit": 1 }),
    );
    assert!(all.starts_with("1 of 3 all cards:"), "{all}");

    // Stats take a tag deck too, count held cards, and refuse queue arguments.
    let card = queue
        .lines()
        .find(|line| line.contains("lavello"))
        .and_then(|line| line.split_whitespace().nth(2))
        .unwrap()
        .to_owned();
    workshop.ok("tessera_hold_card", json!({ "card_id": card }));
    let stats = workshop.ok(
        "tessera_cards",
        json!({ "view": "stats", "deck": "italian" }),
    );
    assert!(stats.contains("2 cards in all, plus 1 held"), "{stats}");
    for arguments in [
        json!({ "view": "stats", "type": "italian" }),
        json!({ "view": "stats", "selection": "bogus" }),
        json!({ "view": "decks", "deck": "italian" }),
    ] {
        workshop.refused("tessera_cards", arguments);
    }

    // A revision belongs to an existing deck.
    let new = workshop.refused(
        "tessera_save_deck",
        json!({ "name": "Fresh", "type": "italian", "revision": 3 }),
    );
    assert!(new.contains("revision needs deck"), "{new}");
}

#[test]
fn queries_refuse_what_they_would_ignore_and_show_fields_by_name() {
    let mut workshop = Workshop::start();
    workshop.ok(
        "tessera_add_note",
        json!({ "page": "Slow reading", "markdown": "- Stage:: Budding\n- [ ] Ask [[Hana Okafor]] about it" }),
    );
    for arguments in [
        json!({ "text": "Slow" }),
        json!({ "filters": [{ "field": "@title", "op": "contains", "value": "Slow" }] }),
        json!({ "source": "notes", "direction": "desc" }),
        json!({ "source": "notes", "filters": [{ "field": "@created", "op": "before", "value": "today" }] }),
    ] {
        workshop.refused("tessera_query", arguments);
    }
    let offset = workshop.refused("tessera_query", json!({ "source": "notes", "offset": -1 }));
    assert_eq!(offset, "offset must be 0 or more");

    let notes = workshop.ok(
        "tessera_query",
        json!({ "source": "notes", "filters": [{ "field": "@title", "op": "contains", "value": "Slow reading" }] }),
    );
    assert!(notes.contains("Stage: Budding (value "), "{notes}");
    let past = workshop.ok("tessera_query", json!({ "source": "notes", "offset": 500 }));
    assert!(past.contains("offset 500 is past the end"), "{past}");

    let tasks = workshop.ok("tessera_query", json!({ "source": "tasks" }));
    let row = tasks.lines().find(|line| line.contains("Ask")).unwrap();
    assert!(row.contains("Ask [[Hana Okafor]] about it"), "{row}");
    assert_eq!(row.matches("todo").count(), 1, "{row}");
}
