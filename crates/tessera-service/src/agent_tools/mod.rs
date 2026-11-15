//! The seven tools the in-app agent and the MCP server both offer, and the
//! readers for their arguments. The MCP server prefixes each name with
//! `tessera_` and adds its annotations; the wording and schemas here are
//! that public contract, and the in-app agent sees the same schemas.

pub mod args;
pub mod edits;

use serde_json::{Value, json};

/// Who reads the catalogue. The MCP server names tools `tessera_…` and
/// offers more of them, such as undo and card holds, which the in-app agent
/// lacks, so its descriptions may point at those.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Mcp,
    App,
}

impl Surface {
    /// A shared tool's name as this surface calls it.
    pub fn tool(self, name: &str) -> String {
        match self {
            Self::Mcp => format!("tessera_{name}"),
            Self::App => name.to_owned(),
        }
    }

    /// `text` where the surface offers the MCP-only tools it names.
    fn mcp(self, text: &str) -> &str {
        if self == Self::Mcp { text } else { "" }
    }
}

/// The block syntax add_note and edit_block read.
pub fn syntax(surface: Surface) -> String {
    format!(
        "Markdown outline: `- ` or `1. ` items nest by indentation, and \
indented lines under an item continue it; every other line is its own block; `#` headings \
become heading blocks that contain what follows; a fenced code block is one block. \
`- [ ] `, `- [x] `, `- [doing] `, `- [waiting] ` and `- [cancelled] ` items become tasks. \
{read_page} output reads back as the same blocks. In block text, \
`[[Page title]]` links a page by title or alias and creates it if missing, \
`[[Page title|label]]` links with a label, `[[2026-10-07]]` links an existing journal day, \
`[[BLOCK_ID]]` references a live block, and `#Tag` or `#[[Multi word tag]]` gives the block \
a type. Quote rows use `((BLOCK_ID))` alone with an attached frozen subtree snapshot; writing \
the marker alone does not capture a snapshot. Reads show the saved text, not live text. \
Flashcards: `A >> B` shows A and asks for B; `A << B` shows B and asks for A, so \
`東京 << Tōkyō` shows Tōkyō and asks for 東京; `A <> B` makes both cards; a trailing \
`A >>>` takes its child outline as the answer, and a trailing `A >>1.` reveals its \
children one at a time in order; a child block `Function ;; makes ATP` under \
`Mitochondria` is a descriptor card that shows `Mitochondria › Function` and asks for \
`makes ATP`; clozes are `The {{{{c1::answer}}}} here` or \
`{{{{c1::answer::hint}}}}`, and repeated numbers make one card. Use one operator per block and \
never mix operators with clozes. Write results list each card with what it shows and asks \
for. Field entries: a line `Name:: value` is its own block and sets that field on its \
parent block, the page itself at the top level or the item it is indented under; \
`Name::` takes the items indented under it as several values. A missing field is created, \
a built-in one (author, lived, published, url, form…) with its kind, and each value must \
read as the field's kind. Values of instance fields{query} are links such as \
`author:: [[George Eliot]]`.",
        read_page = surface.tool("read_page"),
        query = surface.mcp(" (see tessera_query)"),
    )
}

/// What a `revision` argument means.
pub fn revision(surface: Surface) -> String {
    format!(
        "The block's revision from {} (`r3` is 3). When given, \
the change is refused if the block changed since; read it again and retry.",
        surface.tool("read_page")
    )
}

/// One shared tool. `writes` is false for a read; a write is destructive when
/// it removes or replaces existing content.
pub struct Tool {
    pub name: &'static str,
    pub title: &'static str,
    pub description: String,
    pub input_schema: Value,
    pub writes: bool,
    pub destructive: bool,
}

/// The shared tools as `surface` describes them, in the order the MCP server
/// lists them.
pub fn shared(surface: Surface) -> Vec<Tool> {
    let read_page = surface.tool("read_page");
    let add_note = surface.tool("add_note");
    let revision = revision(surface);
    let syntax = syntax(surface);
    vec![
        Tool {
            name: "search",
            title: "Search notes",
            description: "Full-text search over every block. Returns matching blocks with their page.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Words to find." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 20 }
                },
                "required": ["query"]
            }),
            writes: false,
            destructive: false,
        },
        Tool {
            name: "read_page",
            title: "Read a page",
            description: format!("A page or journal day as an indented Markdown outline that {add_note} reads back. Each block ends with an HTML comment holding its ID and revision, then its tags, task planning, project, question, assessment, position, relation, source and its citation key, revisit date, resolution, citations and cards (each with {}); the title's comment covers the page itself. Links to pages show as [[Title]], tags as #Tag or #[[Multi word tag]], field entries as `Name::` and choice values under them as [[Option]]. A text line that would read as structure starts with `\\`, and `-->` shows as `--\\>`.", match surface {
                Surface::Mcp => "the card ID and revision tessera_hold_card takes",
                Surface::App => "its card ID and revision",
            }),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Page title or alias, ignoring case, accents and punctuation." },
                    "date": { "type": "string", "description": "Journal day as YYYY-MM-DD." },
                    "id": { "type": "string", "description": "Any block ID; reads the page that contains it." },
                    "subtree": { "type": "boolean", "default": false, "description": "With id, show only that block and its descendants." }
                }
            }),
            writes: false,
            destructive: false,
        },
        Tool {
            name: "add_note",
            title: "Add a note",
            description: format!("Append an outline to the end of a page (created if missing), a journal day (created if missing) or an existing block. Without page, journal or parent_id it goes to today's journal. Writes are attributed to this agent.{} {syntax}", surface.mcp(" The result lists the cards the note made and any card syntax that made none.")),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "markdown": { "type": "string", "description": "The note as a Markdown outline." },
                    "page": { "type": "string", "description": "Page title or alias, ignoring case, accents and punctuation; give a day as journal. Tags in it, such as #person, file the page." },
                    "journal": { "type": "string", "description": "Journal day as YYYY-MM-DD, or today." },
                    "parent_id": { "type": "string", "description": "Block ID to append children to." },
                    "reason": { "type": "string", "description": "Why this note was written, kept in the change history." }
                },
                "required": ["markdown"]
            }),
            writes: true,
            destructive: false,
        },
        Tool {
            name: "edit_block",
            title: "Edit a block",
            description: format!("Replace a block's text, its heading level, or both. Editing a page's root block renames the page. Text follows {add_note}'s block syntax: [[Title]] links pages, card operators make cards, and `Name:: value` turns the block into a field entry with the value as its first child, or replaces an existing entry's first value; naming another field there is refused."),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Block ID." },
                    "text": { "type": "string", "description": format!("The block's new text, one block only; {read_page}'s escapes are undone.") },
                    "heading": { "type": "integer", "minimum": 0, "maximum": 3, "description": "Heading level 1 to 3, or 0 for none; a page or journal title takes none." },
                    "revision": { "type": "integer", "description": revision },
                    "reason": { "type": "string" }
                },
                "required": ["id"]
            }),
            writes: true,
            destructive: true,
        },
        Tool {
            name: "move_block",
            title: "Move a block",
            description: "Move a block with its children: after the block `after`, first under `parent_id` when `first` is true, or last under `parent_id`. Moving to another page works the same way; pages themselves cannot be moved.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Block ID." },
                    "parent_id": { "type": "string", "description": "New parent: a block or a page's root ID." },
                    "after": { "type": "string", "description": "Sibling to place it after." },
                    "first": { "type": "boolean", "description": "Place it first under parent_id, or first among its current siblings." },
                    "revision": { "type": "integer", "description": revision },
                    "reason": { "type": "string" }
                },
                "required": ["id"]
            }),
            writes: true,
            destructive: false,
        },
        Tool {
            name: "delete_block",
            title: "Delete a block",
            description: format!("Delete a block and its children, or a whole page by its root ID.{}", surface.mcp(" tessera_undo restores it.")),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Block or page root ID." },
                    "revision": { "type": "integer", "description": revision },
                    "reason": { "type": "string" }
                },
                "required": ["id"]
            }),
            writes: true,
            destructive: true,
        },
        Tool {
            name: "set_task",
            title: "Set a task",
            description: "Make a block a task or change its task state; give a status or at least one field. Only the given fields change, and an empty string clears a field other than status. Without a status, a block with no task becomes a todo task, or an appointment when only scheduled and scheduled_time are given. Setting status done records a completion, which advances a repeating task instead. Repeating an undated task schedules it today, and clearing its last date stops the repeat. Without revision, a change made since this call read the block is refused.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Block ID." },
                    "status": { "type": "string", "enum": ["todo", "doing", "waiting", "done", "cancelled", "none"], "description": "none removes the task, making it an ordinary block again; give it alone." },
                    "scheduled": { "type": "string", "description": "YYYY-MM-DD, or empty to clear." },
                    "scheduled_time": { "type": "string", "description": "HH:MM on the scheduled day, or empty to clear." },
                    "deadline": { "type": "string", "description": "YYYY-MM-DD, or empty to clear." },
                    "deadline_time": { "type": "string", "description": "HH:MM on the deadline, or empty to clear." },
                    "warning_days": { "type": "integer", "minimum": 0, "maximum": 365, "description": "Show the task on the agenda this many days before its deadline; 0 clears." },
                    "repeat": { "type": "string", "description": "Repeat interval such as 1d, 2w, 1m or 1y, or none to stop repeating." },
                    "repeat_mode": { "type": "string", "enum": ["fixed", "catch_up", "after_completion"], "description": "fixed moves one interval from the planned date; catch_up moves by whole intervals until after completion (the default); after_completion counts from the completion day." },
                    "priority": { "type": "string", "enum": ["high", "medium", "low", "none"] },
                    "completed_on": { "type": "string", "description": "Completion date for done, YYYY-MM-DD; defaults to today." },
                    "revision": { "type": "integer", "description": revision },
                    "reason": { "type": "string" }
                },
                "required": ["id"]
            }),
            writes: true,
            destructive: false,
        },
    ]
}
