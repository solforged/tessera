---
name: tessera-row-mechanics-audit
description: "Audit or regress-test Tessera outline row mechanics (Enter, Backspace, indent, multi-select, move, fold, zoom, undo) with scenario-matrix lanes and browser proof"
---

# Tessera row mechanics audit

The owner treats outline editing mechanics as a standing priority: regressions there are hard to notice. Run this whenever the outline editor, document layer or selection code changes, or when the owner asks for an audit.

Follow [managing-tessera-task-workspaces](../../../.agents/skills/managing-tessera-task-workspaces/SKILL.md) for the owner and every lane. Prepare in reuse mode inside harness-owned trees and pass the originating briefs/skills with the explicit base.

## Where behaviour lives
- Text-level: `web/src/outline/OutlinePane.tsx` (`editAt`, `rowFocus`, `apply`, `split`, `backspace`, `crossArrow`, `editorKey`, editor hooks), `web/src/outline/editor.ts` (retained CodeMirror), `web/src/document/outline-mechanics.ts` (merge/outdent intents from visible rows), `web/src/document/text-tokens.ts`.
- Structural: `web/src/document/page-document.ts` `edit()` cases `indent`/`outdent`/`move`/`delete`/`merge`/`split` (take `zoomRoot`), `web/src/document/outline-index.ts`, `web/src/outline/visibility.ts`.
- Settled rules: `docs/design.md` "Row mechanics". Tests: `web/src/document/outline-mechanics.test.ts`, `outline-structure.test.ts`, `document.test.ts`.

## Procedure
1. Write two briefs in `local://brief-outline-editing.md` and `local://brief-outline-structure.md`, retaining copies in `TASK_EVIDENCE`: numbered scenario matrix (text-level: split, merge, Delete, arrows, caret, tokens, undo, autosave; structural: indent, outdent, move, multi-select across depths, zoom bounds, delete/restore, fold, selection survival), a "Not yours" list so patches do not collide, and the rule that bugs are fixed at the document layer with a failing-before test. Include explicit base, source/runtime ownership, protected live-data boundaries and acceptance evidence.
2. Launch two `astra-engineer` lanes, `isolated: true`, in one `task` batch. Each uses shared prepare reuse inside its harness tree. Require scoped commits/patches, numbered audit tables and named failing-before tests; no mid-flight build/test/lint/formatter runs. The integrator runs the check set and per-matrix browser smoke after the batch integrates, using separate fresh `TASK_RUN/notebooks` copies, explicit owned HTTP/sync ports (never 4317/4318/5173/43963) and the shared run-owned browser launcher/profile/CDP procedure. Reports/proof go to `TASK_EVIDENCE`; a local:// handoff is not their only retained copy.
3. Approve small contract additions quickly (optional `zoomRoot` on edits, `selectionBefore` on `replaceRange` were both needed). Boundary cases must be silent no-ops without history entries, never alerts.
4. Merge only in the owner's prepared integration tree: use the actual handed-off patch artifact (historically `~/.local/share/omp/sessions/-src-tessera/<session>/<Lane>.patch`) with `git -C "$TASK_SOURCE" apply --3way <absolute-patch>` or cherry-pick the exact scoped SHAs. Resolve there, never through peers' index/refs/files, then run web build and tests once with tool cwd bound to `TASK_SOURCE/web`, isolated runtime and `TESSERA_TEST_BINARY="$TASK_BIN"`.
5. Re-verify the full matrix yourself on a fresh run-owned notebook, not `.tessera/dev` or :4318: `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/row-mechanics" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"` as an exact named service. Record readiness/build/origin and browser launcher handle. Commit explicit owned paths with scoped Git commands; update docs/design.md "Row mechanics" if a rule changed. Landing/shipping is separate authorization, not part of audit cleanup.

## Browser harness gotchas
- `tab.type` clicks first and moves the CodeMirror caret; use `page.keyboard.type` through `tab.run(async ({page}, s) => …, { args: [s] })`.
- `tab.press` rejects chords like `Shift+ArrowDown` or `Meta+z`; use `page.keyboard.down/press/up`.
- Rows are virtualized, so DOM order is not visual order; sort by `getBoundingClientRect().top` and read `--depth` for indentation.
- Scratch-block deletion through `POST /api/batches` (`delete` with `base_revision`, ids from `/api/journal/<date>` then `/api/pages/<id>`) is only for this run's verified private fixture, never dev/live data. Retain the numbered matrix and before/after API/browser proof in `TASK_EVIDENCE`, then follow shared teardown and explicitly hand off retained trials.
