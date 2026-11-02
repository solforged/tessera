---
name: smoke-testing-tessera-agent-dock
description: "Smoke-tests Tessera's agent dock, Settings › Agent and /api/agent routes with a fake model; use to verify streaming, tool edits, chip context and stop/undo behavior without a real model."
---

# Smoke-testing the Tessera agent dock with a fake model

The dock (`web/src/agent/`) talks to the service's `/api/agent/*` routes. The
Rust loop is in `crates/tessera-service/src/agent/`, with providers in a
machine-local `agent.json`. Real models are often unreachable: Amarna's tailnet
llama-server times out, and nothing runs on Ollama :11434 or llama-server :8080.
Use a fake OpenAI-compatible server instead.

## Workspace, run and fixture

- Follow
  [managing-tessera-task-workspaces](../managing-tessera-task-workspaces/SKILL.md)
  to prepare/source the owned workspace and run, including matching
  `TASK_BIN`/`TASK_DIST`.
- Prerequisites: an explicitly permitted backup for notebook
  `01M49AC7D8F2M15G81DF22ETZV` containing `Asabiyya`, an installed Chrome for
  Testing, and a fake SSE provider implementing the contract below. The skill
  does not supply that provider or backup. Keep the provider script in
  `TASK_RUN/tools`, its logs in `TASK_RUN/logs`, and run it as its own
  loopback-only named service through `task_run`.
- Restore with
  `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/dock" restore "<authorized-backup>"`,
  then detach the restored copy using the shared procedure before serving.
- Serve through
  `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/dock" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`.
  Verify `agent.json` is private under `TASK_RUN/state/tessera`, not the user's
  configuration.
- Allocate the fake-provider port separately from the notebook listeners; the
  historical USB trial used 4398. Use the shared owned Chrome launcher/CDP
  procedure with `TASK_RUN/profiles/dock`.

## Fake provider (Bun, bind 127.0.0.1)

`Bun.serve({ port, hostname: '127.0.0.1', fetch })` answers POST
`/v1/chat/completions` with SSE `data: {chat.completion.chunk}` lines and then
`data: [DONE]`. Sleep about 120 ms between chunks so Stop can be tested.

- First request (no `tool` message): stream text deltas, then a `tool_calls`
  delta with
  `{index:0,id,type:'function',function:{name:'add_note',arguments:''}}`. Follow
  with an arguments delta holding `{"target":{"page":"Asabiyya"},"text":"..."}`,
  then `finish_reason:'tool_calls'`.
- Follow-up request (has a `tool` message): stream a final answer citing
  `[[Asabiyya]]`, then `finish_reason:'stop'`.
- Log `messages[0].content.length` and its `^#` headings. That shows which
  context pages reached the model, so you can verify chip exclusion: with every
  chip excluded, the system prompt alone is about 400 chars.

## Checks (headless Chrome for Testing)

1. Settings › Agent: add the llama-server preset, set the address to
   `http://127.0.0.1:<fake>/v1` and the model, then Test should read `Answered`.
2. PUT a key via curl: the response holds only `has_key:true`, and `agent.json`
   has mode 0600.
3. Open a page, open the dock (rail star / ⌃⇧A), and send. Expect streamed text,
   an edit card, a steel row bar and an `.agent-mark` star.
4. Show: the row gains `agent-flash`; for a page not open, it opens beside.
5. Undo from the card and from the star menu. Undo again is refused with a
   readable message (no `(operation None)`).
6. × on a chip strikes it through (check the fake's log). Drag a rendered
   `.outline-reference` onto `.agent-thread`: the dock gets `drop-target`, a
   chip is added, and no pane opens. Only `[data-open-page]` and references are
   draggable, not sidebar nav buttons.
7. Stop mid-stream: the turn reads `Stopped` and no edit is made.
8. Viewports 960 (overlay) and 400 (full screen).

## Gotchas

- `Menu` dismisses before running an item's action. Actions must not read
  `<Show>` callback accessors, or they hit a stale read and do nothing.
- Run the web suite from `TASK_SOURCE/web` through `task_run` with
  `TESSERA_TEST_BINARY="$TASK_BIN"` and an owned test port. A later
  shared-target build must not replace the copied binary under test.
- The `build:demo` tsc error in `src/demo/worker.ts` comes from wasm typings
  missing in worktrees. It predates the dock.

Retain the fake's request logs, screenshots and configuration-permission
evidence in `TASK_EVIDENCE`, then follow shared teardown for the browser
launcher, fake provider and notebook service.
