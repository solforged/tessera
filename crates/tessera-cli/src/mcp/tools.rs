//! The tools `tools/list` advertises, with their input schemas.

use std::sync::LazyLock;

use serde_json::{Map, Value, json};

use tessera_service::agent_tools::REVISION;

fn read_only() -> Value {
    json!({ "readOnlyHint": true })
}

fn writes(destructive: bool) -> Value {
    json!({ "readOnlyHint": false, "destructiveHint": destructive, "idempotentHint": false })
}

/// The tools, built once.
static TOOLS: LazyLock<Value> = LazyLock::new(list);

pub(super) fn tools() -> &'static Value {
    &TOOLS
}

/// The arguments the named tool's input schema declares, or `None` when no
/// tool has that name.
pub(super) fn arguments(name: &str) -> Option<&'static Map<String, Value>> {
    let tool = TOOLS.as_array()?.iter().find(|tool| tool["name"] == name)?;
    tool["inputSchema"]["properties"].as_object()
}

fn list() -> Value {
    let shared: Vec<Value> = tessera_service::agent_tools::shared()
        .into_iter()
        .map(mcp_tool)
        .collect();
    let Value::Array(only) = exclusive() else {
        unreachable!("exclusive tools are an array")
    };
    // list_pages stays between search and read_page, as it does today.
    let mut tools = vec![shared[0].clone(), only[0].clone()];
    tools.extend(shared[1..].iter().cloned());
    tools.extend(only[1..].iter().cloned());
    Value::Array(tools)
}

fn mcp_tool(tool: tessera_service::agent_tools::Tool) -> Value {
    json!({
        "name": format!("tessera_{}", tool.name),
        "title": tool.title,
        "description": tool.description,
        "inputSchema": tool.input_schema,
        "annotations": if tool.writes { writes(tool.destructive) } else { read_only() },
    })
}

fn exclusive() -> Value {
    json!([
        {
            "name": "tessera_list_pages",
            "title": "List pages",
            "description": "Named pages by title, optionally followed by journal days, newest first. A list that stops short names the offset that lists the rest.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
                    "offset": { "type": "integer", "minimum": 0, "default": 0 },
                    "journals": { "type": "boolean", "default": false, "description": "Include journal days." }
                }
            },
            "annotations": read_only()
        },
        {
            "name": "tessera_revisits",
            "title": "Read revisits",
            "description": "Questions and notes due for a revisit, earliest first, one line each with its due date, last revisit and proposed next_on.",
            "inputSchema": { "type": "object", "properties": {
                "due": { "type": "string", "description": "today or YYYY-MM-DD; defaults to today." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50 }
            }},
            "annotations": read_only()
        },
        {
            "name": "tessera_revisit",
            "title": "Change a revisit",
            "description": "Revisited and keep_recurrent record a revisit; later moves its date without an event. Resolve clears its date and never accepts an assessment. Reopen returns a resolved note to working. Undo with tessera_undo.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" },
                "action": { "type": "string", "enum": ["revisited", "later", "resolve", "reopen", "keep_recurrent"] },
                "next_on": { "type": ["string", "null"], "description": "Next revisit date, YYYY-MM-DD, or null for none. Required for revisited, later and keep_recurrent; left out for resolve and reopen." },
                "revision": { "type": "integer", "description": REVISION },
                "reason": { "type": "string" }
            }, "required": ["id", "action"] },
            "annotations": writes(false)
        },
        {
            "name": "tessera_set_relation",
            "title": "Set a relation",
            "description": "Set an ordinary block's explicit relation kind, or remove it with null. Its first link is the target; its source comes from its ancestors. Does not change the block's text. Undo with tessera_undo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Block ID." },
                    "relation": { "type": ["string", "null"], "enum": ["supports", "disputes", "qualifies", "answers", null] },
                    "revision": { "type": "integer", "description": REVISION },
                    "reason": { "type": "string" }
                },
                "required": ["id", "relation"]
            },
            "annotations": writes(false)
        },
        {
            "name": "tessera_relations",
            "title": "Find relations",
            "description": "Read authored relations, one line each with source, target, holders and problems, under a count. Give at least one filter besides limit. Holder filters also match an endpoint that is the holder itself.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["supports", "disputes", "qualifies", "answers"] },
                    "source": { "type": "string", "description": "Source block or page ID." },
                    "target": { "type": "string", "description": "Target block or page ID." },
                    "source_holder": { "type": "string", "description": "Source holder page ID." },
                    "target_holder": { "type": "string", "description": "Target holder page ID." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50 }
                }
            },
            "annotations": read_only()
        },
        {
            "name": "tessera_tasks",
            "title": "Find tasks",
            "description": "The agenda (view agenda): everything scheduled, due, warned, overdue or completed on a day, then for each following day what is scheduled or due on it. Or a task list (view list) filtered by status, dates, priority, project or a saved task view. Each view refuses the other's arguments.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "view": { "type": "string", "enum": ["agenda", "list"], "default": "agenda" },
                    "date": { "type": "string", "description": "Agenda: first day, YYYY-MM-DD or today (the default)." },
                    "days": { "type": "integer", "minimum": 1, "maximum": 31, "default": 1, "description": "Agenda: how many days." },
                    "unplanned": { "type": "boolean", "default": false, "description": "Agenda: also list open tasks with no date." },
                    "status": { "type": "array", "items": { "type": "string", "enum": ["todo", "doing", "waiting", "done", "cancelled"] }, "description": "List: only these statuses." },
                    "include": { "type": "string", "enum": ["unfinished", "unfinished_or_recent", "all"], "description": "List: unfinished_or_recent adds tasks finished in the last week. Defaults to unfinished, or to all when status names done or cancelled." },
                    "scheduled_from": { "type": "string", "description": "List: scheduled on or after YYYY-MM-DD." },
                    "scheduled_through": { "type": "string", "description": "List: scheduled on or before YYYY-MM-DD." },
                    "deadline_from": { "type": "string", "description": "List: deadline on or after YYYY-MM-DD." },
                    "deadline_through": { "type": "string", "description": "List: deadline on or before YYYY-MM-DD." },
                    "priority": { "type": "string", "enum": ["high", "medium", "low"], "description": "List: only this priority." },
                    "project": { "type": "string", "description": "List: only tasks under this project block ID." },
                    "saved": { "type": "string", "description": "List: run the saved task view with this name instead of the filters." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50, "description": "List: the most tasks to show." }
                }
            },
            "annotations": read_only()
        },
        {
            "name": "tessera_cards",
            "title": "Find flashcards",
            "description": "Cards with their IDs, revisions, kinds, fronts, answers and next due dates. Give block_id or page alone for the cards written there (held ones included); otherwise view queue lists due, new or all cards, optionally from one deck or one type's members; view stats gives due and held counts, retention and a week's forecast, optionally for one deck; view decks lists saved decks and tag decks. Arguments the chosen mode does not use are refused. A tag on a card's own block is a tag deck named with that tag; study it with deck or type, and do not create a saved deck for it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "block_id": { "type": "string", "description": "Cards made by this block." },
                    "page": { "type": "string", "description": "Cards made by blocks on this page: a title, a page or journal day ID, YYYY-MM-DD, or today." },
                    "view": { "type": "string", "enum": ["queue", "stats", "decks"], "default": "queue" },
                    "selection": { "type": "string", "enum": ["due", "new", "all"], "description": "Queue: which cards; defaults to the deck's own selection, otherwise due." },
                    "deck": { "type": "string", "description": "Queue or stats: a saved deck's or tag deck's name or ID." },
                    "type": { "type": "string", "description": "Queue: only cards from members of this type, by name; not with deck." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 20, "description": "Queue: the most cards to show." }
                }
            },
            "annotations": read_only()
        },
        {
            "name": "tessera_hold_card",
            "title": "Hold or release a card",
            "description": "Hold a card so it leaves review queues without losing its history, or release it. Use for cards that are wrong, outdated or keep failing; fix the text with tessera_edit_block instead when the wording is the problem.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "card_id": { "type": "string", "description": "Card ID from tessera_cards or tessera_read_page." },
                    "held": { "type": "boolean", "default": true, "description": "false releases the card." },
                    "revision": { "type": "integer", "description": "The card's revision, rN in its card label; when given, the change is refused if the card changed since." },
                    "reason": { "type": "string" }
                },
                "required": ["card_id"]
            },
            "annotations": writes(false)
        },
        {
            "name": "tessera_save_deck",
            "title": "Create, change or delete a deck",
            "description": "A saved deck is a review queue: the cards whose own block matches its type, text and field filters. A tag on a card's own block is already a deck, named with that tag, and appears in tessera_cards view decks; do not create a saved deck just to study those cards. Save a deck when the queue needs a filter a tag cannot express. Cards join through their own block, not their page. Avoid child field entries under >>> and >>1. cards, whose children are their answer. Without deck this creates a deck; with deck it changes that deck, keeping its source unless type, text or filters are given; delete removes the deck and leaves its cards alone. The result says how many cards the deck holds.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "deck": { "type": "string", "description": "An existing saved deck's name or ID, to change or delete it; give the ID when several decks share the name." },
                    "name": { "type": "string", "description": "The deck's name, unique ignoring case; required for a new deck." },
                    "type": { "type": "string", "description": "Only cards on blocks of this type, by name." },
                    "text": { "type": "string", "description": "Only cards on blocks whose text contains these words." },
                    "filters": {
                        "type": "array",
                        "description": "Field conditions on the card blocks, as in tessera_query. @ attributes need type, and @kind, @resolved and @revisit are refused.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": { "type": "string", "description": "Field name." },
                                "op": { "type": "string", "enum": ["is", "is_not", "contains", "gt", "gte", "lt", "lte", "set", "empty"], "default": "is" },
                                "value": { "type": "string", "description": "Compared without case; not used by set and empty." },
                                "or_empty": { "type": "boolean", "default": false, "description": "Also match blocks without a value." }
                            },
                            "required": ["field"]
                        }
                    },
                    "selection": { "type": "string", "enum": ["due", "new", "all"], "description": "Which of its cards the deck reviews; due (which includes new cards after due ones) for a new deck." },
                    "delete": { "type": "boolean", "default": false },
                    "revision": { "type": "integer", "description": "Only with deck: the deck's revision from tessera_cards view decks. The change is refused if the deck changed since; without revision, if it changed since this call read it." },
                    "reason": { "type": "string" }
                }
            },
            "annotations": writes(true)
        },
        {
            "name": "tessera_query",
            "title": "Query notes and entities",
            "description": "Without source, type or view: list types, fields and saved views; every other argument needs one of the three. Sources: notes, questions, positions, sources, tasks, highlights. type alone selects that type's members, tagged blocks included; source notes without type selects titled notes. Filters and sorts accept field names or attributes. All sources: @title, @page, @created, @updated. Notes: @kind, @resolved, @revisit. Questions: @state, @parent, @program, @readings, @current, @last_assessed, @revisit, @inline. Positions: @holder, @subject, @question, @relation, @target_holder, @cites. Sources: @creator, @contributor, @cited_by, @cited_in, @highlights, @citation_key. Tasks: @status, @scheduled, @deadline (or @due), @priority, @repeat, @project. Highlights: @source, @color. Instance equality uses block IDs. Dates accept today, -30d or +7d, YYYY-MM-DD, YYYY-MM or YYYY; or_empty also includes missing values. Rows include entity identity, attributes and editable field value block IDs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "source": { "type": "string", "enum": ["notes", "questions", "positions", "sources", "tasks", "highlights"] },
                    "type": { "type": "string", "description": "A type's name, such as Book." },
                    "view": { "type": "string", "description": "A saved view's name, instead of type." },
                    "text": { "type": "string", "description": "Words to match: in the titles and glosses of titled notes, otherwise in block text." },
                    "filters": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": { "type": "string", "description": "Field name." },
                                "op": { "type": "string", "enum": ["is", "is_not", "contains", "gt", "gte", "lt", "lte", "set", "empty"], "default": "is" },
                                "value": { "type": "string", "description": "Text, an instance ID or a date; date filters also accept today, -30d or +7d, YYYY-MM or YYYY." },
                                "or_empty": { "type": "boolean", "default": false }
                            },
                            "required": ["field"]
                        }
                    },
                    "sort": { "type": "string", "description": "A field name, or title, created or updated." },
                    "direction": { "type": "string", "enum": ["asc", "desc"], "default": "asc", "description": "Needs sort." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50 },
                    "offset": { "type": "integer", "minimum": 0, "default": 0 }
                }
            },
            "annotations": read_only()
        },
        {
            "name": "tessera_library",
            "title": "Read the library",
            "description": "Books and articles in the library. view sources lists them; contents shows a source's chapters with passage ordinals; read returns passages in order from an ordinal (default: the saved reading position) with passage IDs for tessera_cite; search finds passages by text; highlights lists highlight blocks and their quotes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "view": { "type": "string", "enum": ["sources", "contents", "read", "search", "highlights"], "default": "sources" },
                    "source": { "type": "string", "description": "A source's page title or ID; required for contents and read, optional for search and highlights." },
                    "text": { "type": "string", "description": "Sources: title, author or other text to match." },
                    "state": { "type": "array", "items": { "type": "string", "enum": ["inbox", "reading", "finished", "abandoned"] }, "description": "Sources: only these reading states." },
                    "from": { "type": "integer", "minimum": 0, "description": "Read: first passage ordinal." },
                    "query": { "type": "string", "description": "Search: words to find." },
                    "unprocessed": { "type": "boolean", "default": false, "description": "Highlights: only those not yet processed." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "Sources and highlights: up to 500, default 50. Read: up to 200, default 30. Search: up to 200, default 20. Not used by contents." }
                }
            },
            "annotations": read_only()
        },
        {
            "name": "tessera_cite",
            "title": "Cite passages",
            "description": "Link existing blocks to library passages, as one change. Without quote a citation covers the whole passage, or through end_passage_id; with quote it covers the first exact occurrence of that text in the passage. A citation the block already has is refused. Typical use: add a note with tessera_add_note, then cite its blocks by the IDs in the result.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "citations": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "block_id": { "type": "string", "description": "The block that cites." },
                                "passage_id": { "type": "string", "description": "Passage ID from tessera_library." },
                                "end_passage_id": { "type": "string", "description": "Last passage of a range in the same source." },
                                "quote": { "type": "string", "description": "Exact, non-empty text inside the passage to cite instead of all of it." },
                                "revision": { "type": "integer", "description": REVISION }
                            },
                            "required": ["block_id", "passage_id"]
                        }
                    },
                    "reason": { "type": "string" }
                },
                "required": ["citations"]
            },
            "annotations": writes(false)
        },
        {
            "name": "tessera_recent_changes",
            "title": "Recent history",
            "description": "Workshop history from people, clients and agents, newest first, with change numbers for tessera_undo and whether undo is available. A full list names the before value that lists older changes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 20 },
                    "before": { "type": "integer", "description": "Only changes numbered below this." }
                }
            },
            "annotations": read_only()
        },
        {
            "name": "tessera_sync",
            "title": "Check sync",
            "description": "Whether this workshop syncs with a hub, when it last synced, how many changes made here have not reached the hub, and the last sync error. The service syncs on its own a few seconds after each change and every three minutes; now: true syncs at once and reports the result.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "now": { "type": "boolean", "default": false, "description": "Sync before reporting." }
                }
            },
            "annotations": writes(false)
        },
        {
            "name": "tessera_undo",
            "title": "Undo a change",
            "description": "Reverse one undoable history entry. Refused when a block or card it touched, or a block nested in what it added, was changed since; undo later changes first. Pages and fields it created are kept while other blocks use them. The undo is another history entry, numbered in the result, and can itself be undone when reversible.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "change": { "type": "integer", "description": "Change number from a write result or tessera_recent_changes." }
                },
                "required": ["change"]
            },
            "annotations": writes(true)
        }
    ])
}
