---
name: editing-live-tessera-notes
description: "Writes or edits notes in the live Tessera notebook via POST /api/agent-changes on :4318 (note creation and block editing), not MCP, when the user requests live-notebook changes."
---

# Writing or editing notes in the live Tessera notebook

Use this from any working directory when the user asks to put a note in the live
notebook or to change one. Do not use a throwaway notebook, and do not register
or spawn `tessera mcp` for this. MCP is not configured for `omp`.

## Workspace, runtime and authorization

First complete
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
and source its prepared environment. Retain live-edit request manifests,
receipts and pre-edit backups in `TASK_EVIDENCE`.

Live writes are allowed only for the exact notebook and changes the user
requested; read `/api/service` and the target page immediately before writing,
record their identities and preserve revision/idempotency safeguards. QA uses a
private copy, never the live registry, sharing route, pairing state or installed
service.

## Service

The launch agent serves the live notebook at `http://127.0.0.1:4318`.
`GET /api/service` should report that port. Do not write to the sync listener on
4319, or to 4317.

## Add a note

`POST /api/agent-changes` with `Content-Type: application/json`:

```json
{
  "actor": { "kind": "agent", "name": "omp" },
  "reason": "Why this note was written.",
  "kind": "add_note",
  "target": { "kind": "journal", "date": "2026-10-12" },
  "blocks": [
    {
      "text": "Heading",
      "heading": 2,
      "children": [{ "text": "One paragraph.", "children": [] }]
    }
  ]
}
```

- `target` can instead be `{"kind": "page", "title": "Inbox"}` or
  `{"kind": "block", "id": "<ULID>"}`. A missing page or journal day is created.
  For a journal day always use `kind: journal` with `date`; a date-shaped page
  title is refused. A page title matches an existing page by exact title first,
  then by a unique folded title or alias (case, accents, punctuation ignored); a
  name two pages share is refused. A `#kind` tag in the title
  (`Ada Lovelace #person`) files the page, an existing one too.
- Each block is `{text, heading?, task?, children}`. `text` is NOT Markdown:
  `# Title` or `- [ ] Buy` stay literal text. Headings are `heading: 1..3`; a
  task is `"task": {"status": "todo"}` (also `doing`, `waiting`, `done`, `cancelled`).
  Unknown fields such as `type` are refused with 422 `invalid_json` naming the
  field (since the 2026-11-01 fixes).
- Card syntax (`>>`, `<<`, `{{c1::…}}`) and `[[Title]]` links inside `text` are
  parsed; `[[Name]]` also links a unique alias.
- A `Name:: value` line must be a block on its own. The service turns it into a
  field entry: the block's text becomes a link to the field, and the value
  becomes its child. Built-in names (gloss, aliases, author, lived, published,
  `url`, form, active, affiliated with, coined by/in) get their built-in kind;
  values must read as that kind (`lived:: b. 1947` or `1871–1937`,
  `active:: 2015–?`, `published:: 2017-06-12`, `form:: paper`). Several aliases
  go under one `aliases::` entry as children.
- Attribute the actor as `omp`, so the change can be undone from the History
  pane. Send an `Idempotency-Key` header to make a retry safe: the same key and
  body replays the first receipt.

A 200 response body includes `seq`, `summary`, `page.id` and `blocks`. To undo,
`POST /api/history/{seq}/undo` with
`{"actor": {"kind": "agent", "name": "omp"}}`. `GET /api/history?limit=N` lists
entries newest first.

The historical bulk loader `/tmp/tessera-bench/content/load.py` and its
`LOADER.md` are not a supplied tool. Bulk loading requires an available,
reviewed loader source and separate authorization for its exact target; this
skill does not register MCP or reconstruct a missing loader.

## Find a block by text

`GET /api/search?q=<text>&limit=10` returns matching blocks with their pages;
use the block `id` as a `block` target or for edits.

## Edit existing blocks

Other `kind` values are defined by the `AgentEdit` enum in
`crates/tessera-core/src/agent.rs`: `edit_block` (`id`, `revision`, `text`,
`heading`), `move_block`, `delete_block`, `set_task`, `set_relation`, `revisit`,
`set_card_held`, `cite`, `save_deck`, `delete_deck`.

- Read the page first, so you have the current block ids and their `revision`.
  Pass that `revision` with every edit, so you never overwrite a change made
  since you read it.
- Editing a page's root block renames the page. Never rename or delete the
  `Fields` page: the service allows it (audit 2026-10-31) and it breaks built-in
  fields.
- Field values are the child rows of a field entry. To change a field's value,
  such as a gloss or gist, edit the child row's text, not the entry row.
- Before a batch of edits, resolve the explicit live workshop path from the
  service and back it up with
  `task_run "$TASK_BIN" --workshop "$LIVE_WORKSHOP" backup "$TASK_EVIDENCE/before-<topic>"`.
  Do not infer a workshop from the isolated HOME. Record every `seq`, and report
  the retained backup path and seq range to the user.
- Afterwards, rescan to confirm the problem is gone. For example, check that no
  page's gloss text appears again elsewhere on that page.

## Reading pages

- `GET /api/roots` lists every root, with `id`, `text`, `kind` and `archived`.
  Journal days appear as `YYYY-MM-DD`.
- `GET /api/pages/{id}` returns `root`, `root_manual_types` and `rows`. Each row
  has a `depth` and a `block` with `id`, `parent_id`, `heading`, `text` and
  `revision`.
- `GET /api/blocks/{id}` returns a single block. Use it to resolve field ids
  such as `[[01M...]]` to their names.
- A field entry row's text is `[[<fieldId>]]`. In the live notebook the gloss
  field id is `01M4RZJX971SKDQGB4JJJ582DM`.
- A page has a perspective when a block's text is `[[holderId|Name]]` with a
  position on it. Its Gist and Work fields are child field entries of that
  block.

## Gloss and gist convention

On a thesis or concept page, the Gloss says what the claim is about: its topic
and its role. Each perspective's Gist states the claim itself in the holder's
voice, without "X's claim that…", because the holder's name is already on the
slip. Never put the same sentence in both.

## Batch of concept notes (one page per idea)

This is the pattern used for the Muqaddimah batch on 2026-10-12:

- Post one `add_note` per page, with `target: {kind: page, title}`.
- Make the first block `Gloss:: <what the idea is about>`.
- Cite quoted spans in body paragraphs as
  `[[<Source page title or id>|exact quoted words|3.12]]`. The last part is the
  locator, which renders in mono with the source's siglum in the gutter. A
  citation to a source that only has a catalog record links to the source page
  instead.
- Cross-link sibling notes with `[[Title]]` or `[[Title|label]]`. Missing titles
  are created, so keep titles exact. Check that `[[` and `]]` balance before
  posting.
- Check every quote against the actual source text first, and record each `seq`.
- New pages land in Unfiled. Filing them, adding aliases, saving views and
  making spreads are done in the UI: File from Unfiled, Page menu › Add alias,
  `Find in <Plural>…` with chips such as `cites:KHA`, and Spread for two to five
  notes.

For browser checks, back up the explicit live workshop into `TASK_EVIDENCE`,
then
`task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/check" restore <backup>`.
Apply the shared copied-lock/sync-detachment safeguards before starting
`task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/check" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`.
Use the shared fresh-browser launch with `$TASK_RUN/profiles/check`, retain
screenshots/profile and the recorded origin/handles in `TASK_EVIDENCE`, then
follow shared teardown.

## `kvasir`

kvasir-box (`tag:kvasir`, `100.67.171.46`) runs the tailnet Grok Bot and has its
own Tessera replica. SSH to it is refused. Notes written there sync to this Mac,
so a refused SSH connection does not mean the notebook is missing.
