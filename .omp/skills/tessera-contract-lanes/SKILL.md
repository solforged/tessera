---
name: tessera-contract-lanes
description: "Delegate Tessera core/service/web slices to isolated astra-engineer lanes against written briefs, then merge their patches onto main"
---

# Tessera contract lanes

Tessera (`~/src/tessera`): Rust workspace (`tessera-core` SQLite model, `tessera-service` axum, `tessera-cli`) plus a Solid client in `web/`. Sol trusts Astra/Sol models for logic and verification, not design or wording. The main session writes briefs and owns `docs/design.md`, `web/src/tokens.css`, styling and user-facing strings.

## Map first
- `crates/tessera-core/src/model.rs` `Operation` enum mirrors `web/src/api/types.ts` (snake_case). Service routes: `crates/tessera-service/src/lib.rs` `router()`.
- Shell targets: `web/src/shell/contract.ts` `OpenTarget`; `App.tsx` has `PaneView` union, `paneLabel()`, a `Switch` in `Pane`, and one restore branch for scroll-only panes. A new non-page pane touches only those.
- Document layer (`web/src/document/{contract,types,page-document,index}.ts`) carries every edit with undo; new operations need an Edit, an Action with inverse, and a compiler case in `index.ts`.

## Brief (`local://brief-<slice>.md`)
Behavior with file:line citations; core migration + operations; service shape; web contract with existing `ui/` components only (no colours, px literals, new CSS files beyond one layout file); a strict "Not yours" list; acceptance: fmt, clippy, `cargo test --workspace`, `bun run --cwd web build`, `bun test --cwd web`, then a browser smoke on a throwaway notebook and free port (never 4317/4318/5173) with pasted aria/screenshot proof.

## Launch
`task` with `agent: astra-engineer`, `isolated: true`, one lane per slice, shared context repeating AGENTS.md commit rules. Answer lane IRC scope requests quickly; approve document-layer additions when they unify a raw API path.

## Merge
- Patches that fail auto-merge live at `~/.local/share/omp/sessions/-src-tessera/<session>/<Lane>.patch`; `git apply --3way` then resolve with `conflict://`. `@both` for adjacent case/test additions, but check each side closes its braces (ours' switch case without `{}` broke twice).
- Two lanes appending migrations: renumber the later one and add its `DROP TABLE` to every downgrade fixture in `crates/tessera-core/tests/{fields,types_changes}.rs`.
- Rerun all checks, restart the dev service (`./target/debug/tessera --notebook .tessera/dev serve --assets web/dist`), smoke in the browser, then one Conventional Commit per lane with a 72-col body and no lists.
- Style the lane's pane yourself afterwards against `docs/design.md`.
