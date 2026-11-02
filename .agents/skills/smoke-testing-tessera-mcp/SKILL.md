---
name: smoke-testing-tessera-mcp
description: "Smoke-tests Tessera's MCP standard-I/O server (18 tools incl. tasks, cards, decks, query, library, cite, sync) or POST /api/agent-changes against a throwaway notebook when checking agent integrations."
---

# Smoke-testing Tessera's MCP server

The server lives in `crates/tessera-cli/src/mcp/` (mod.rs protocol + `Api`
helper, tools.rs schemas and SYNTAX,
notes/tasks/cards/query/library/sync/relations/revisits.rs handlers, outline.rs
parser). Writes go through `AgentEdit` in `crates/tessera-core/src/agent.rs`;
every new write kind needs a `Step` and an inverse there so undo works
(non-block resources such as cards and decks track revisions from
`changes.committed` `$.cards`/`$.decks`).

## Shared lifecycle

Complete
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
and source its prepared environment before this smoke. Each concurrent smoke
lane uses its own prepared run.

1. From `TASK_SOURCE`, build/stage the release CLI using the shared build
   procedure:
   `CARGO_TARGET_DIR="$TASK_TARGET" cargo build --release --locked -p tessera-cli`,
   then `cp "$TASK_TARGET/release/tessera" "$TASK_BIN"`.
2. Start a uniquely named service with
   `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/hub" serve --port <owned-free-hub-http> --sync-port <owned-free-hub-sync>`,
   ready log `service listening`. Record the actual origin and both ports;
   `--sync-port 0` is an ephemeral listener, not disabled sync.
3. For sync checks, use
   `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/bot" sync clone <recorded-hub-origin>`,
   then serve the replica with distinct owned HTTP/sync ports and point MCP at
   it. Its log shows `sync finished pushed=…`; the hub logs
   `sync push received`. Stop only the recorded hub service to see `sync failed`
   and `tessera_sync` report the error. `sync status` works while the replica's
   service runs. Never exercise Sharing/Pair against host Tailscale.
4. For library/cite checks, ingest the bundled EPUB:
   `task_run "$TASK_BIN" --workshop <owned-notebook> add --wait "$TASK_SOURCE/web/src/demo/meditations.epub"`.
5. Drive raw JSON-RPC from Python `eval`: `Popen` the staged `TASK_BIN` with
   `--workshop <owned-notebook> mcp`, merging `runtime_env` from
   `TASK_RUN/context.json` over the inherited environment. Send one JSON per
   line (`initialize` with clientInfo.name, `notifications/initialized`,
   `tools/list`, `tools/call`), read one line per request. Use a
   `call(tool, args_dict)` helper; keyword arguments collide with tool arguments named `name`.
   Record the exact process handle, and respawn only it after rebuilding and
   restaging the binary.
6. Cover: `add_note` with a paragraph followed by `Source:: x` (must become its
   own block), items with indented `Name:: v` lines (children of the item),
   `A << B` (report says "shows B and asks for A"), broken `Kepler >>`;
   `edit_block` with a multi-line text holding a field line (reported as a
   problem); `tessera_save_deck` with filters on a `Deck::` child field, rename,
   delete, undo each; `tessera_cards` view decks; `tessera_sync` with and without
   `now`; tasks, query, library, cite and hold as before.
7. Agent change numbers (`receipt.seq`) differ from notebook change sequences on
   replicas; undo takes the agent number.
8. Retain request/reply transcripts, agent receipts and notebook provenance in
   `TASK_EVIDENCE`, then terminate the recorded MCP process and follow shared
   teardown.

Transfer fixes as scoped patches/commits to the named integration owner under
the shared procedure. If landing/shipping is separately authorized, use
`landing-lane-patches-around-dirty-peer-trees` and
`shipping-tessera-live-builds`.

The installed :4318 app only gets new endpoints after an explicitly authorized
ship; this smoke test never writes to or restarts it.
