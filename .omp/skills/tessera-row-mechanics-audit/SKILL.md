---
name: tessera-row-mechanics-audit
description: "Audit or regress-test Tessera outline row mechanics (Enter, Backspace, indent, multi-select, move, fold, zoom, undo) with scenario-matrix lanes and browser proof"
---

# Tessera row mechanics audit

The owner treats outline editing mechanics as a standing priority: regressions there are hard to notice. Run this whenever the outline editor, document layer or selection code changes, or when the owner asks for an audit.

## Where behaviour lives
- Text-level: `web/src/outline/OutlinePane.tsx` (`editAt`, `rowFocus`, `apply`, `split`, `backspace`, `crossArrow`, `editorKey`, editor hooks), `web/src/outline/editor.ts` (retained CodeMirror), `web/src/document/outline-mechanics.ts` (merge/outdent intents from visible rows), `web/src/document/text-tokens.ts`.
- Structural: `web/src/document/page-document.ts` `edit()` cases `indent`/`outdent`/`move`/`delete`/`merge`/`split` (take `zoomRoot`), `web/src/document/outline-index.ts`, `web/src/outline/visibility.ts`.
- Settled rules: `docs/design.md` "Row mechanics". Tests: `web/src/document/outline-mechanics.test.ts`, `outline-structure.test.ts`, `document.test.ts`.

## Procedure
1. Write two briefs in `local://brief-outline-editing.md` and `local://brief-outline-structure.md`: numbered scenario matrix (text-level: split, merge, Delete, arrows, caret, tokens, undo, autosave; structural: indent, outdent, move, multi-select across depths, zoom bounds, delete/restore, fold, selection survival), a "Not yours" list so the two patches do not collide, and the rule that bugs are fixed at the document layer with a failing-before test.
2. Launch two `astra-engineer` lanes, `isolated: true`, in one `task` batch. Require a browser smoke on a throwaway notebook and free port (never 4317/4318/5173/43963) and an audit table in `local://audit-<slice>.md`.
3. Approve small contract additions quickly (optional `zoomRoot` on edits, `selectionBefore` on `replaceRange` were both needed). Boundary cases must be silent no-ops without history entries, never alerts.
4. Merge: patches that fail auto-merge sit in `~/.local/share/omp/sessions/-src-tessera/<session>/<Lane>.patch`; `git apply --3way`, resolve via `conflict://`, then `bun run --cwd web build && bun test --cwd web`.
5. Re-verify yourself on the dev notebook (:4318) before committing; one Conventional Commit per lane; update "Row mechanics" in `docs/design.md` if a rule changed.

## Browser harness gotchas
- `tab.type` clicks first and moves the CodeMirror caret; use `page.keyboard.type` through `tab.run(async ({page}, s) => …, { args: [s] })`.
- `tab.press` rejects chords like `Shift+ArrowDown` or `Meta+z`; use `page.keyboard.down/press/up`.
- Rows are virtualized, so DOM order is not visual order; sort by `getBoundingClientRect().top` and read `--depth` for indentation.
- Clean scratch blocks afterwards via `POST /api/batches` (`delete` with `base_revision`), reading ids from `/api/journal/<date>` then `/api/pages/<id>`.
