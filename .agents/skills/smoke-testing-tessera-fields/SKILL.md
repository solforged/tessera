---
name: smoke-testing-tessera-fields
description: "Smoke-tests and UX-audits Tessera field entries, field sheet slots, type templates, Fill missing fields and fields on Library source pages; use for browser write verification and desktop or phone fields clickarounds."
---

# Smoke-testing Tessera fields

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to prepare/source the field smoke's workspace and run.

1. Build the selected source with serialized
   `CARGO_TARGET_DIR="$TASK_TARGET" cargo build --manifest-path "$TASK_SOURCE/Cargo.toml" -p tessera-cli --locked`,
   copy `"$TASK_TARGET/debug/tessera"` to `TASK_BIN`, and build web assets into
   `TASK_DIST` from `TASK_SOURCE/web`.
2. Serve a fresh notebook as a unique named service (never :4318):
   `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/fields" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`.
   Record readiness, both actual ports and origin; do not delete/reuse fixed
   notebook paths.
3. Seed via JS `eval` with one POST `/api/batches`
   `{actor:{kind:'client',name}, idempotency_key: ulid(), operations}`:
   - Fields page id: `GET /api/fields` → `page_id`. Each field definition =
     `insert` under it with the name; non-text kinds add
     `set_field_kind{id,base_revision:1,kind}` (instance, date, choice, number,
     checkbox, `url`, identifier).
   - Choice options = child blocks of the definition.
   - Type page = `create_page{id,title:'Book'}`; template =
     `set_type_fields{type_id,base_revision:1,fields:[...]}`.
   - Member block text `Dune #Book`; entry = child `[[fieldId]]`; values = its
     children (`[[pageId]]` for instance/choice, `yes`/`no` for checkbox).
   - Include: multi-value entries, an entry with no value, an invalid value, a
     member with no fields, a free note under a member.
4. Browser: use the shared owned Chrome for Testing launcher/CDP procedure with
   `TASK_RUN/profiles/fields`,
   `--headless=new --no-first-run --hide-scrollbars`, then
   `tab.emulate({viewport:{width:1400,height:900,deviceScaleFactor:1}})`. Scroll
   with `document.querySelector('.outline-pane').scrollTop`.
5. Verify writes through `GET /api/pages/<id>` (`rows[]` in preorder,
   `block.parent_id`, `block.text`), not only screenshots. Check: slot click per
   kind (choice options, date picker, instance `[[]]` completion, checkbox
   ticked), template-order placement, ⌘Z steps, `::` picker ranking, type page
   Template reorder/remove/add, Fill missing fields + its Undo, 420 px viewport.
6. Retain screenshots and write/API proof in `TASK_EVIDENCE`, then follow shared
   teardown for the browser launcher and notebook service.

## UX audit / clickaround of fields (no code changes)

Use `auditing-tessera-ui-flows`, “Fields UX audit / clickaround”, for the
two-notebook audit, interaction checklist and screenshot report. Include its 412
px pass in addition to the 420 px write-verification pass above.

Landing is separate from fields smoke. Only when authorized, fetch/rebase in the
owned integration checkout with `git -C "$TASK_SOURCE" fetch origin` and
`git -C "$TASK_SOURCE" rebase origin/main`, preserving main's applicable
neighboring documentation. Run the requested typecheck, web suite with
`TESSERA_TEST_BINARY="$TASK_BIN"` under `task_run`, and build once after
integration. Use `mise run land -- --wait` with tool `cwd: TASK_SOURCE` (give
`--title "type(scope): summary"` for a batch); issues are optional for durable
tracking. Never push main or squash/rebase merge, and never move a peer's
checkout when main advances. Shipping needs separate authorization.
