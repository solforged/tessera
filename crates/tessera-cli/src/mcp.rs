//! `tessera mcp`: a Model Context Protocol server on stdin and stdout for
//! agents. Each tool call goes to the running notebook service over its
//! loopback HTTP API, so the service stays the only writer. Messages are
//! newline-delimited JSON-RPC 2.0; logs go to stderr.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Context;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};
use tessera_core::{
    Actor, Block, BlockInPage, BlockKind, Note, NoteBlock, NoteReceipt, NoteTarget, PageView,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::{checked, service};

/// Newest first; the client's version is echoed when it is one of these.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Tessera is a local outline notebook. Every note is a tree of \
blocks on a named page or a journal day. Search or read before writing to avoid duplicates. \
Write with tessera_add_note, which appends to the end of a page, journal day or block.";

const SYNTAX: &str = "Markdown outline: `- ` or `1. ` items nest by indentation; `#`, `##` \
and `###` headings become heading blocks that contain the content below them; other lines \
become blocks; indented lines under an item continue that item. In block text, `[[Page \
title]]` links a page by title and creates it if missing, `[[Page title|label]]` links with a \
label, `[[2026-10-07]]` links an existing journal day, `[[BLOCK_ID]]` references a block, \
`#Tag` or `#[[Multi word tag]]` gives the block a type, and `front >> back` makes a \
flashcard.";

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
            "tools/list" => success(id, json!({ "tools": tools() })),
            "tools/call" => {
                let name = params["name"].as_str().unwrap_or_default();
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                let result = match name {
                    "tessera_search" => self.search(&arguments).await,
                    "tessera_list_pages" => self.list_pages(&arguments).await,
                    "tessera_read_page" => self.read_page(&arguments).await,
                    "tessera_add_note" => self.add_note(&arguments).await,
                    _ => return Some(failure(id, -32602, &format!("Unknown tool: {name}"))),
                };
                let (text, error) = match result {
                    Ok(text) => (text, false),
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

    async fn search(&self, arguments: &Value) -> anyhow::Result<String> {
        let query = string(arguments, "query")?.context("query is required")?;
        let limit = arguments["limit"].as_u64().unwrap_or(20).to_string();
        let (client, base) = service(self.notebook).await?;
        let hits: Vec<BlockInPage> = checked(
            client
                .get(format!("{base}/api/search"))
                .query(&[("q", query), ("limit", limit.as_str())])
                .send()
                .await?,
        )
        .await?
        .json()
        .await?;
        if hits.is_empty() {
            return Ok(format!("No blocks match {query:?}."));
        }
        let mut text = String::new();
        for hit in hits {
            text.push_str(&format!(
                "- {} (block {}) on {} {:?} (page {})\n",
                hit.block.text.replace('\n', " "),
                hit.block.id,
                kind_label(hit.page.kind),
                hit.page.text,
                hit.page.id
            ));
        }
        Ok(text)
    }

    async fn list_pages(&self, arguments: &Value) -> anyhow::Result<String> {
        let limit = arguments["limit"].as_u64().unwrap_or(100) as usize;
        let journals = arguments["journals"].as_bool().unwrap_or(false);
        let (client, base) = service(self.notebook).await?;
        let roots: Vec<Block> = checked(client.get(format!("{base}/api/roots")).send().await?)
            .await?
            .json()
            .await?;
        let mut text = String::new();
        for root in roots
            .iter()
            .filter(|root| journals || root.kind == BlockKind::Page)
            .take(limit)
        {
            text.push_str(&format!(
                "- {} {:?} (id {})\n",
                kind_label(root.kind),
                root.text,
                root.id
            ));
        }
        Ok(if text.is_empty() {
            "The notebook has no pages yet.".into()
        } else {
            text
        })
    }

    async fn read_page(&self, arguments: &Value) -> anyhow::Result<String> {
        let (client, base) = service(self.notebook).await?;
        let get = async |path: String| -> anyhow::Result<Block> {
            Ok(checked(client.get(format!("{base}{path}")).send().await?)
                .await?
                .json()
                .await?)
        };
        let root = match (
            string(arguments, "title")?,
            string(arguments, "date")?,
            string(arguments, "id")?,
        ) {
            (Some(title), None, None) => get(format!("/api/pages/by-title/{}", segment(title)))
                .await
                .with_context(|| format!("No page is titled {title:?}"))?,
            (None, Some(date), None) => get(format!("/api/journal/{}", segment(date)))
                .await
                .with_context(|| format!("No journal day {date}"))?,
            (None, None, Some(id)) => get(format!("/api/blocks/{}", segment(id))).await?,
            _ => anyhow::bail!("Give exactly one of title, date or id."),
        };
        let page: PageView = checked(
            client
                .get(format!("{base}/api/pages/{}", root.page_id))
                .send()
                .await?,
        )
        .await?
        .json()
        .await?;
        Ok(render(&page))
    }

    async fn add_note(&self, arguments: &Value) -> anyhow::Result<String> {
        let markdown = string(arguments, "markdown")?.context("markdown is required")?;
        let blocks = outline(markdown);
        anyhow::ensure!(!blocks.is_empty(), "The note has no content.");
        let target = match (
            string(arguments, "page")?,
            string(arguments, "journal")?,
            string(arguments, "parent_id")?,
        ) {
            (Some(title), None, None) => NoteTarget::Page {
                title: title.to_owned(),
            },
            (None, journal, None) => NoteTarget::Journal {
                date: journal.filter(|date| *date != "today").map(str::to_owned),
            },
            (None, None, Some(id)) => NoteTarget::Block { id: id.to_owned() },
            _ => anyhow::bail!("Give at most one of page, journal or parent_id."),
        };
        let note = Note {
            actor: Actor::Agent {
                name: self.agent.clone(),
            },
            reason: string(arguments, "reason")?.map(str::to_owned),
            target,
            blocks,
        };
        let (client, base) = service(self.notebook).await?;
        let receipt: NoteReceipt = checked(
            client
                .post(format!("{base}/api/notes"))
                .json(&note)
                .send()
                .await?,
        )
        .await?
        .json()
        .await?;
        let mut text = format!(
            "Added {} block{} to {} {:?} (page {}).",
            receipt.blocks.len(),
            if receipt.blocks.len() == 1 { "" } else { "s" },
            kind_label(receipt.page.kind),
            receipt.page.text,
            receipt.page.id,
        );
        if !receipt.created_pages.is_empty() {
            let titles: Vec<_> = receipt
                .created_pages
                .iter()
                .map(|page| format!("{:?}", page.text))
                .collect();
            text.push_str(&format!(" Created pages: {}.", titles.join(", ")));
        }
        text.push_str(&format!(" New block IDs: {}.", receipt.blocks.join(", ")));
        Ok(text)
    }
}

fn tools() -> Value {
    json!([
        {
            "name": "tessera_search",
            "title": "Search notes",
            "description": "Full-text search over every block. Returns matching blocks with their page.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Words to find." },
                    "limit": { "type": "integer", "minimum": 1, "default": 20 }
                },
                "required": ["query"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "tessera_list_pages",
            "title": "List pages",
            "description": "Named pages by title, optionally followed by journal days, newest first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "default": 100 },
                    "journals": { "type": "boolean", "default": false, "description": "Include journal days." }
                }
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "tessera_read_page",
            "title": "Read a page",
            "description": "A page or journal day as an indented Markdown outline. Each block ends with an HTML comment holding its ID, for use as parent_id. Links to pages show as [[Title]].",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Page title, ignoring case." },
                    "date": { "type": "string", "description": "Journal day as YYYY-MM-DD." },
                    "id": { "type": "string", "description": "Any block ID; reads the page that contains it." }
                }
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "tessera_add_note",
            "title": "Add a note",
            "description": format!("Append an outline to the end of a page (created if missing), a journal day (created if missing) or an existing block. Without page, journal or parent_id it goes to today's journal. Writes are attributed to this agent. {SYNTAX}"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "markdown": { "type": "string", "description": "The note as a Markdown outline." },
                    "page": { "type": "string", "description": "Page title." },
                    "journal": { "type": "string", "description": "Journal day as YYYY-MM-DD, or today." },
                    "parent_id": { "type": "string", "description": "Block ID to append children to." },
                    "reason": { "type": "string", "description": "Why this note was written, kept in the change history." }
                },
                "required": ["markdown"]
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false }
        }
    ])
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

fn segment(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn kind_label(kind: BlockKind) -> &'static str {
    match kind {
        BlockKind::Journal => "journal day",
        _ => "page",
    }
}

/// The page as an indented outline. References to pages and journal days
/// show their title so an agent can write them back as `[[Title]]`.
fn render(page: &PageView) -> String {
    let titles: HashMap<&str, &str> = page
        .targets
        .iter()
        .filter(|block| block.kind != BlockKind::Block)
        .map(|block| (block.id.as_str(), block.text.as_str()))
        .collect();
    let mut text = format!("# {} <!-- {} -->\n", page.root.text, page.root.id);
    for row in &page.rows {
        let indent = "  ".repeat(row.depth as usize);
        let heading = row
            .block
            .heading
            .map(|level| format!("{} ", "#".repeat(level as usize)))
            .unwrap_or_default();
        let body = titled(&row.block.text, &titles).replace('\n', &format!("\n{indent}  "));
        let archived = if row.block.archived {
            " (archived)"
        } else {
            ""
        };
        text.push_str(&format!(
            "{indent}- {heading}{body}{archived} <!-- {} -->\n",
            row.block.id
        ));
    }
    text
}

fn titled(text: &str, titles: &HashMap<&str, &str>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let Some(end) = rest[start + 2..].find("]]") else {
            break;
        };
        let reference = &rest[start + 2..start + 2 + end];
        let (target, alias) = match reference.split_once('|') {
            Some((target, alias)) => (target, Some(alias)),
            None => (reference, None),
        };
        out.push_str(&rest[..start]);
        match titles.get(target) {
            Some(title) => {
                out.push_str("[[");
                out.push_str(title);
                if let Some(alias) = alias {
                    out.push('|');
                    out.push_str(alias);
                }
                out.push_str("]]");
            }
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &rest[start + 2 + end + 2..];
    }
    out.push_str(rest);
    out
}

/// Parse a Markdown outline into note blocks. Headings contain what follows
/// them until a heading of the same or a higher level; list items nest by
/// indentation; a fenced code block stays one block.
fn outline(markdown: &str) -> Vec<NoteBlock> {
    let mut blocks = Vec::new();
    // Open heading levels, outermost first.
    let mut headings: Vec<u8> = Vec::new();
    // Marker columns of the open list items, outermost first.
    let mut items: Vec<usize> = Vec::new();
    // Whether the last block can take a continuation line: an item (with
    // its content column) or a paragraph not yet ended by a blank line.
    let mut open: Option<Continuation> = None;
    let mut lines = markdown.lines();
    while let Some(line) = lines.next() {
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if open == Some(Continuation::Paragraph) {
                open = None;
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let fence = &trimmed[..3];
            let mut code = vec![trimmed.to_owned()];
            for line in lines.by_ref() {
                code.push(line.get(indent..).unwrap_or(line.trim_start()).to_owned());
                if line.trim().starts_with(fence) {
                    break;
                }
            }
            let code = code.join("\n");
            match open {
                Some(Continuation::Item(column)) if indent >= column => {
                    append(&mut blocks, &code);
                }
                _ => {
                    items.clear();
                    push(&mut blocks, headings.len(), text_block(code));
                    open = None;
                }
            }
            continue;
        }
        if let Some((level, title)) = heading(trimmed).filter(|_| indent < 4) {
            while headings.last().is_some_and(|open| *open >= level) {
                headings.pop();
            }
            push(
                &mut blocks,
                headings.len(),
                NoteBlock {
                    text: title.to_owned(),
                    heading: Some(level),
                    children: Vec::new(),
                },
            );
            headings.push(level);
            items.clear();
            open = None;
            continue;
        }
        if thematic_break(trimmed) {
            open = None;
            continue;
        }
        if let Some(content) = item(trimmed) {
            while items.last().is_some_and(|column| *column > indent) {
                items.pop();
            }
            if items.last() != Some(&indent) {
                items.push(indent);
            }
            push(
                &mut blocks,
                headings.len() + items.len() - 1,
                text_block(content.to_owned()),
            );
            open = Some(Continuation::Item(indent + (trimmed.len() - content.len())));
            continue;
        }
        match open {
            Some(Continuation::Item(column)) if indent >= column => append(&mut blocks, trimmed),
            Some(Continuation::Paragraph) => append(&mut blocks, trimmed),
            _ => {
                items.clear();
                push(&mut blocks, headings.len(), text_block(trimmed.to_owned()));
                open = Some(Continuation::Paragraph);
            }
        }
    }
    blocks
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Continuation {
    /// A list item whose text starts at this column.
    Item(usize),
    Paragraph,
}

fn text_block(text: String) -> NoteBlock {
    NoteBlock {
        text,
        heading: None,
        children: Vec::new(),
    }
}

/// Add a block `depth` levels down the last branch, or as deep as it goes.
fn push(blocks: &mut Vec<NoteBlock>, depth: usize, block: NoteBlock) {
    match blocks.last_mut() {
        Some(last) if depth > 0 => push(&mut last.children, depth - 1, block),
        _ => blocks.push(block),
    }
}

/// Continue the most recently added block on a new line.
fn append(blocks: &mut [NoteBlock], line: &str) {
    let mut last = blocks.last_mut().expect("a continuation follows a block");
    while let Some(child) = last.children.last_mut() {
        last = child;
    }
    last.text.push('\n');
    last.text.push_str(line);
}

/// `# Title` to `###### Title`, with deeper levels shown as level 3. `#Tag`
/// without a space is a tag, not a heading.
fn heading(line: &str) -> Option<(u8, &str)> {
    let level = line.bytes().take_while(|byte| *byte == b'#').count();
    let title = line[level..].strip_prefix([' ', '\t'])?.trim();
    ((1..=6).contains(&level) && !title.is_empty()).then(|| (level.min(3) as u8, title))
}

/// The text after a `-`, `*`, `+`, `1.` or `1)` list marker.
fn item(line: &str) -> Option<&str> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    let rest = if digits > 0 && digits < 10 {
        line[digits..].strip_prefix(['.', ')'])?
    } else {
        line.strip_prefix(['-', '*', '+'])?
    };
    if rest.is_empty() {
        return Some(rest);
    }
    rest.strip_prefix([' ', '\t']).map(str::trim_start)
}

fn thematic_break(line: &str) -> bool {
    let compact: String = line.chars().filter(|ch| !ch.is_whitespace()).collect();
    compact.len() >= 3
        && ["-", "*", "_"]
            .iter()
            .any(|mark| compact.chars().all(|ch| ch.to_string() == *mark))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(blocks: &[NoteBlock]) -> Vec<String> {
        fn walk(blocks: &[NoteBlock], depth: usize, out: &mut Vec<String>) {
            for block in blocks {
                let heading = block.heading.map(|h| format!("h{h} ")).unwrap_or_default();
                out.push(format!("{}{heading}{}", "  ".repeat(depth), block.text));
                walk(&block.children, depth + 1, out);
            }
        }
        let mut out = Vec::new();
        walk(blocks, 0, &mut out);
        out
    }

    #[test]
    fn headings_contain_following_content_until_a_peer_heading() {
        let blocks = outline(
            "# Book\nIntro line\n## Part one\n- a\n  - a1\n- b\n## Part two\n- c\n# Next\nend",
        );
        assert_eq!(
            shape(&blocks),
            [
                "h1 Book",
                "  Intro line",
                "  h2 Part one",
                "    a",
                "      a1",
                "    b",
                "  h2 Part two",
                "    c",
                "h1 Next",
                "  end",
            ]
        );
    }

    #[test]
    fn items_nest_by_indentation_and_dedent_to_the_matching_level() {
        let blocks = outline("1. one\n   * deep\n      + deeper\n2. two\n\t- tabbed\n- three");
        assert_eq!(
            shape(&blocks),
            ["one", "  deep", "    deeper", "two", "  tabbed", "three"]
        );
    }

    #[test]
    fn indented_lines_continue_an_item_and_paragraph_lines_join_until_a_blank() {
        let blocks = outline("- item\n  more\n\n  after blank\nfirst\nsecond\n\nthird");
        assert_eq!(
            shape(&blocks),
            ["item\nmore\nafter blank", "first\nsecond", "third"]
        );
    }

    #[test]
    fn tags_are_not_headings_and_fences_stay_whole() {
        let blocks = outline(
            "#Idea worth keeping\n```rust\n- not an item\n\n# nor a heading\n```\n---\n- x",
        );
        assert_eq!(
            shape(&blocks),
            [
                "#Idea worth keeping",
                "```rust\n- not an item\n\n# nor a heading\n```",
                "x",
            ]
        );
    }

    #[test]
    fn references_to_pages_render_as_titles_and_keep_aliases() {
        let titles = HashMap::from([("01J0000000000000000000000A", "Dune")]);
        assert_eq!(
            titled(
                "see [[01J0000000000000000000000A]] and [[01J0000000000000000000000A|it]] and [[01J0000000000000000000000B]]",
                &titles
            ),
            "see [[Dune]] and [[Dune|it]] and [[01J0000000000000000000000B]]"
        );
    }
}
