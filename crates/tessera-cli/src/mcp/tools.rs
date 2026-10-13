//! The tools `tools/list` advertises, with their input schemas.

use serde_json::{Value, json};

const SYNTAX: &str = "Markdown outline: `- ` or `1. ` items nest by indentation; `#`, `##` \
and `###` headings become heading blocks that contain the content below them; other lines \
become blocks; indented lines under an item continue that item; `- [ ] `, `- [x] `, \
`- [doing] `, `- [waiting] ` and `- [cancelled] ` items become tasks. In block text, \
`[[Page title]]` links a page by title and creates it if missing, `[[Page title|label]]` \
links with a label, `[[2026-10-07]]` links an existing journal day, `[[BLOCK_ID]]` \
references a live block, and `#Tag` or `#[[Multi word tag]]` gives the block a type. \
Quote rows use `((BLOCK_ID))` alone with an attached frozen subtree snapshot; writing \
the marker alone does not capture a snapshot. Reads show the saved text, not live text. \
Flashcards: `A >> B` shows A and asks for B; `A << B` shows B and asks for A, so \
`東京 << Tōkyō` shows Tōkyō and asks for 東京; `A <> B` makes both cards; a trailing \
`A >>>` takes its child outline as the answer, and a trailing `A >>1.` reveals its \
children one at a time in order; a child block `Function ;; makes ATP` under \
`Mitochondria` is a descriptor card that shows `Mitochondria › Function` and asks for \
`makes ATP`; clozes are `The {{c1::answer}} here` or \
`{{c1::answer::hint}}`, and repeated numbers make one card. Use one operator per block and \
never mix operators with clozes. Write results list each card with what it shows and asks \
for. Field entries: a line `Name:: value` is its own block and sets that field on its \
parent block, the page itself at the top level or the item it is indented under (the \
field is created when missing); `Name::` with indented children gives several values. \
Values of instance fields (see tessera_query) are links such as \
`Author:: [[George Eliot]]`.";

const REVISION: &str = "The block's revision from tessera_read_page (`r3` is 3). When given, \
the change is refused if the block changed since; read it again and retry.";

fn read_only() -> Value {
    json!({ "readOnlyHint": true })
}

fn writes(destructive: bool) -> Value {
    json!({ "readOnlyHint": false, "destructiveHint": destructive, "idempotentHint": false })
}

pub(super) fn tools() -> Value {
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
            "annotations": read_only()
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
            "annotations": read_only()
        },
        {
            "name": "tessera_read_page",
            "title": "Read a page",
            "description": "A page or journal day as an indented Markdown outline. Each block ends with an HTML comment holding its ID and revision, then its tags, task planning, project, question, citations and cards (with card IDs for tessera_hold_card). Links to pages show as [[Title]] and field entries as `Name::`, the forms tessera_add_note writes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Page title, ignoring case." },
                    "date": { "type": "string", "description": "Journal day as YYYY-MM-DD." },
                    "id": { "type": "string", "description": "Any block ID; reads the page that contains it." },
                    "subtree": { "type": "boolean", "default": false, "description": "With id, show only that block and its descendants." }
                }
            },
            "annotations": read_only()
        },
        {
            "name": "tessera_add_note",
            "title": "Add a note",
            "description": format!("Append an outline to the end of a page (created if missing), a journal day (created if missing) or an existing block. Without page, journal or parent_id it goes to today's journal. Writes are attributed to this agent. The result lists the cards the note made and any card syntax that made none. {SYNTAX}"),
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
            "annotations": writes(false)
        },
        {
            "name": "tessera_edit_block",
            "title": "Edit a block",
            "description": "Replace a block's text, its heading level, or both. Editing a page's root block renames the page. Text follows tessera_add_note's block syntax: [[Title]] links pages, card operators make cards, and `Name:: value` turns the block into a field entry with the value as its first child.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Block ID." },
                    "text": { "type": "string", "description": "The block's new text, one block only." },
                    "heading": { "type": "integer", "minimum": 0, "maximum": 3, "description": "Heading level 1 to 3, or 0 for none." },
                    "revision": { "type": "integer", "description": REVISION },
                    "reason": { "type": "string" }
                },
                "required": ["id"]
            },
            "annotations": writes(true)
        },
        {
            "name": "tessera_move_block",
            "title": "Move a block",
            "description": "Move a block with its children: after the block `after`, first under `parent_id` when `first` is true, or last under `parent_id`. Moving to another page works the same way; pages themselves cannot be moved.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Block ID." },
                    "parent_id": { "type": "string", "description": "New parent: a block or a page's root ID." },
                    "after": { "type": "string", "description": "Sibling to place it after." },
                    "first": { "type": "boolean", "description": "Place it first under parent_id, or first among its current siblings." },
                    "revision": { "type": "integer", "description": REVISION },
                    "reason": { "type": "string" }
                },
                "required": ["id"]
            },
            "annotations": writes(false)
        },
        {
            "name": "tessera_delete_block",
            "title": "Delete a block",
            "description": "Delete a block and its children, or a whole page by its root ID. tessera_undo restores it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Block or page root ID." },
                    "revision": { "type": "integer", "description": REVISION },
                    "reason": { "type": "string" }
                },
                "required": ["id"]
            },
            "annotations": writes(true)
        },
        {
            "name": "tessera_set_task",
            "title": "Set a task",
            "description": "Make a block a task or change its task state. Only the given fields change; an empty string clears a field. Setting status done records a completion, which advances a repeating task instead. Repeating an undated task schedules it today.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Block ID." },
                    "status": { "type": "string", "enum": ["todo", "doing", "waiting", "done", "cancelled", "none"], "description": "none makes it an ordinary block again." },
                    "scheduled": { "type": "string", "description": "YYYY-MM-DD, or empty to clear." },
                    "scheduled_time": { "type": "string", "description": "HH:MM on the scheduled day, or empty to clear." },
                    "deadline": { "type": "string", "description": "YYYY-MM-DD, or empty to clear." },
                    "deadline_time": { "type": "string", "description": "HH:MM on the deadline, or empty to clear." },
                    "warning_days": { "type": "integer", "minimum": 0, "description": "Show the task on the agenda this many days before its deadline; 0 clears." },
                    "repeat": { "type": "string", "description": "Repeat interval such as 1d, 2w, 1m or 1y, or none to stop repeating." },
                    "repeat_mode": { "type": "string", "enum": ["fixed", "catch_up", "after_completion"], "description": "fixed moves one interval from the planned date; catch_up moves by whole intervals until after completion (the default); after_completion counts from the completion day." },
                    "priority": { "type": "string", "enum": ["high", "medium", "low", "none"] },
                    "completed_on": { "type": "string", "description": "Completion date for done, YYYY-MM-DD; defaults to today." },
                    "revision": { "type": "integer", "description": REVISION },
                    "reason": { "type": "string" }
                },
                "required": ["id"]
            },
            "annotations": writes(false)
        },
        {
            "name": "tessera_revisits",
            "title": "Read revisits",
            "description": "Read due questions and notes, earliest first, with proposed next dates.",
            "inputSchema": { "type": "object", "properties": {
                "due": { "type": "string", "description": "today or YYYY-MM-DD; defaults to today." }
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
                "next_on": { "type": ["string", "null"], "description": "Next revisit date, YYYY-MM-DD, or null to clear it." },
                "revision": { "type": "integer", "description": REVISION },
                "reason": { "type": "string" }
            }, "required": ["id", "action", "next_on"] },
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
            "description": "Read authored relations with their source, target, holders and problems. Give at least one filter besides limit. Holder filters also match an endpoint that is the holder itself.",
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
            "description": "The agenda (view agenda): everything scheduled, due, warned, overdue or completed on a day, then for each following day what is scheduled or due on it. Or a task list (view list) filtered by status, dates, priority, project or a saved task view.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "view": { "type": "string", "enum": ["agenda", "list"], "default": "agenda" },
                    "date": { "type": "string", "description": "Agenda: first day, YYYY-MM-DD or today (the default)." },
                    "days": { "type": "integer", "minimum": 1, "maximum": 31, "default": 1, "description": "Agenda: how many days." },
                    "unplanned": { "type": "boolean", "default": false, "description": "Agenda: also list open tasks with no date." },
                    "status": { "type": "array", "items": { "type": "string", "enum": ["todo", "doing", "waiting", "done", "cancelled"] }, "description": "List: only these statuses." },
                    "include": { "type": "string", "enum": ["unfinished", "unfinished_or_recent", "all"], "default": "unfinished", "description": "List: unfinished_or_recent adds tasks finished in the last week." },
                    "scheduled_from": { "type": "string", "description": "List: scheduled on or after YYYY-MM-DD." },
                    "scheduled_through": { "type": "string", "description": "List: scheduled on or before YYYY-MM-DD." },
                    "deadline_from": { "type": "string", "description": "List: deadline on or after YYYY-MM-DD." },
                    "deadline_through": { "type": "string", "description": "List: deadline on or before YYYY-MM-DD." },
                    "priority": { "type": "string", "enum": ["high", "medium", "low"], "description": "List: only this priority." },
                    "project": { "type": "string", "description": "List: only tasks under this project block ID." },
                    "saved": { "type": "string", "description": "List: run the saved task view with this name instead of the filters." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50 }
                }
            },
            "annotations": read_only()
        },
        {
            "name": "tessera_cards",
            "title": "Find flashcards",
            "description": "Cards with their IDs, kinds, fronts, answers and next due dates. Give block_id or page for the cards written there (held ones included); otherwise view queue lists due, new or all cards, optionally from a deck or a type's members. view stats gives due counts, retention and a week's forecast; view decks lists decks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "block_id": { "type": "string", "description": "Cards made by this block." },
                    "page": { "type": "string", "description": "Cards made by blocks on the page with this title." },
                    "view": { "type": "string", "enum": ["queue", "stats", "decks"], "default": "queue" },
                    "selection": { "type": "string", "enum": ["due", "new", "all"], "default": "due", "description": "Queue: which cards." },
                    "deck": { "type": "string", "description": "Queue or stats: a deck's name or ID." },
                    "type": { "type": "string", "description": "Queue: only cards from members of this type, by name." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 20 }
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
                    "revision": { "type": "integer", "description": "The card's revision; when given, the change is refused if the card changed since." },
                    "reason": { "type": "string" }
                },
                "required": ["card_id"]
            },
            "annotations": writes(false)
        },
        {
            "name": "tessera_save_deck",
            "title": "Create, change or delete a deck",
            "description": "A deck is a saved review queue: the cards whose own block matches its type, text and field filters, the same selection tessera_query uses. Cards join a deck through their blocks, not their page, so give each card block what the deck selects, for example a child field entry `Deck:: Kanji` under `東 >> dōng`, then save a deck with filters [{\"field\": \"Deck\", \"value\": \"kanji\"}]. Avoid child entries under `>>>` and `>>1.` cards, whose children are their answer. Without deck this creates a deck; with deck it changes that deck, keeping its source unless type, text or filters are given; delete removes the deck and leaves its cards alone. The result says how many cards the deck holds.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "deck": { "type": "string", "description": "An existing deck's name or ID, to change or delete it." },
                    "name": { "type": "string", "description": "The deck's name; required for a new deck." },
                    "type": { "type": "string", "description": "Only cards on blocks of this type, by name." },
                    "text": { "type": "string", "description": "Only cards on blocks whose text contains these words." },
                    "filters": {
                        "type": "array",
                        "description": "Field conditions on the card blocks, as in tessera_query.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": { "type": "string", "description": "Field name." },
                                "op": { "type": "string", "enum": ["is", "is_not", "contains", "gt", "gte", "lt", "lte", "set", "empty"], "default": "is" },
                                "value": { "type": "string", "description": "Compared without case; not used by set and empty." }
                            },
                            "required": ["field"]
                        }
                    },
                    "selection": { "type": "string", "enum": ["due", "new", "all"], "description": "Which of its cards the deck reviews; due (which includes new cards after due ones) for a new deck." },
                    "delete": { "type": "boolean", "default": false },
                    "revision": { "type": "integer", "description": "The deck's revision from tessera_cards view decks; when given, the change is refused if the deck changed since." },
                    "reason": { "type": "string" }
                }
            },
            "annotations": writes(true)
        },
        {
            "name": "tessera_query",
            "title": "Query notes and entities",
            "description": "Without source, type or view: list types, fields and saved views. Query sources: notes (default), questions, positions, sources, tasks, highlights. Filters and sorts accept field names or attributes. All sources: @title, @page, @created, @updated. Notes: @kind, @resolved, @revisit. Questions: @state, @parent, @program, @readings, @current, @last_assessed, @revisit, @inline. Positions: @holder, @subject, @relation, @target_holder, @cites. Sources: @creator, @cited_by, @highlights. Tasks: @status, @due, @scheduled, @project. Highlights: @source, @color. Instance equality uses block IDs. Dates accept today, -30d or +7d; or_empty also includes missing values. Rows include entity identity, attributes and editable field value block IDs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "source": { "type": "string", "enum": ["notes", "questions", "positions", "sources", "tasks", "highlights"] },
                    "type": { "type": "string", "description": "A type's name, such as Book." },
                    "view": { "type": "string", "description": "A saved view's name, instead of type." },
                    "text": { "type": "string", "description": "Only blocks whose text contains this." },
                    "filters": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": { "type": "string", "description": "Field name." },
                                "op": { "type": "string", "enum": ["is", "is_not", "contains", "gt", "gte", "lt", "lte", "set", "empty"], "default": "is" },
                                "value": { "type": "string", "description": "Text, an instance ID or a date; date filters also accept today, -30d or +7d." },
                                "or_empty": { "type": "boolean", "default": false }
                            },
                            "required": ["field"]
                        }
                    },
                    "sort": { "type": "string", "description": "A field name, or title, created or updated." },
                    "direction": { "type": "string", "enum": ["asc", "desc"], "default": "asc" },
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
                    "source": { "type": "string", "description": "A source's page title or ID; required for contents and read." },
                    "text": { "type": "string", "description": "Sources: title, author or other text to match." },
                    "state": { "type": "array", "items": { "type": "string", "enum": ["inbox", "reading", "finished", "abandoned"] }, "description": "Sources: only these reading states." },
                    "from": { "type": "integer", "minimum": 0, "description": "Read: first passage ordinal." },
                    "query": { "type": "string", "description": "Search: words to find." },
                    "unprocessed": { "type": "boolean", "default": false, "description": "Highlights: only those not yet processed." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500 }
                }
            },
            "annotations": read_only()
        },
        {
            "name": "tessera_cite",
            "title": "Cite passages",
            "description": "Link existing blocks to library passages, as one change. Without quote a citation covers the whole passage, or through end_passage_id; with quote it covers the first exact occurrence of that text in the passage. Typical use: add a note with tessera_add_note, then cite its blocks by the IDs in the result.",
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
                                "quote": { "type": "string", "description": "Exact text inside the passage to cite instead of all of it." },
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
            "title": "Recent agent changes",
            "description": "Changes made through these tools by any agent, newest first, with their change numbers for tessera_undo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "default": 20 }
                }
            },
            "annotations": read_only()
        },
        {
            "name": "tessera_sync",
            "title": "Check sync",
            "description": "Whether this notebook syncs with a hub, when it last synced, how many changes made here have not reached the hub, and the last sync error. The service syncs on its own a few seconds after each change and every three minutes; now: true syncs at once and reports the result.",
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
            "description": "Reverse one change made through these tools. Refused when a block or card it touched was changed since by someone else; undo later changes first. Pages and fields it created are kept while other blocks use them.",
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
