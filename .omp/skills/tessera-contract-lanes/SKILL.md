---
name: tessera-contract-lanes
description: "Delegate Tessera core/service/web slices to isolated astra-engineer lanes against written briefs, then merge their patches onto main"
---

# Tessera contract lanes

Tessera (`~/src/tessera`): Rust workspace (`tessera-core` SQLite model, `tessera-service` axum, `tessera-cli`) plus a Solid client in `web/`. Delegate logic and verification to engine specialists, not design or wording. The main session writes briefs and owns `docs/design.md`, `web/src/tokens.css`, styling and user-facing strings.

Use [managing-tessera-task-workspaces](../../../.agents/skills/managing-tessera-task-workspaces/SKILL.md) for every lane and the integration owner. Preserve harness worktree lifecycle by preparing in reuse mode inside each owned harness tree.

## Map first
- `crates/tessera-core/src/model.rs` `Operation` enum mirrors `web/src/api/types.ts` (snake_case). Service routes: `crates/tessera-service/src/lib.rs` `router()`.
- Shell targets: `web/src/shell/contract.ts` `OpenTarget`; `App.tsx` has `PaneView` union, `paneLabel()`, a `Switch` in `Pane`, and one restore branch for scroll-only panes. A new non-page pane touches only those.
- Document layer (`web/src/document/{contract,types,page-document,index}.ts`) carries every edit with undo; new operations need an Edit, an Action with inverse, and a compiler case in `index.ts`.

## Brief (`local://brief-<slice>.md`)
Behavior with file:line citations; core migration + operations; service shape; web contract with existing `ui/` components only (no colours, px literals, new CSS files beyond one layout file); a strict "Not yours" list; explicit base and source ownership; task-specific failing-before tests and smoke criteria. Lanes return scoped commits/patches and do not run build/lint/tests/formatters mid-flight. The integrator runs fmt/clippy/workspace tests, web build/tests and browser proof once after integration, using the shared isolated runtime, copied matching `TASK_BIN`, `TASK_DIST`, fresh notebooks and owned free HTTP/sync ports (never 4317/4318/5173). Save reports and proof in `TASK_EVIDENCE`; `local://` briefs may be delivery copies, not the sole retained evidence.

## Launch
Use one `task` batch with `agent: astra-engineer`, `isolated: true`, one lane per independent slice and one integration owner. Pass the explicit base, applicable AGENTS.md/commit rules and originating skill/brief paths. Each child establishes ownership, then runs the shared prepare helper in reuse mode inside its harness tree and sources its own environment. Answer scope requests quickly; approve document-layer additions when they unify a raw API path. Never let lane source isolation imply shared runtime or permission to land/ship.

## Merge
- Integrate scoped commits/patches only in the owner's prepared checkout. Failed auto-merge patches have historically lived under `~/.local/share/omp/sessions/-src-tessera/<session>/<Lane>.patch`; use the actual reported artifact, not an assumed fixed location. Apply with `git -C "$TASK_SOURCE" apply --3way <absolute-patch>` or cherry-pick exact SHAs there, resolve conflicts and preserve both sides' braces for adjacent case/test additions. Do not use shared-index/ref replay or overwrite peers' dirty files.
- Two lanes appending migrations: renumber the later one and add its `DROP TABLE` to every downgrade fixture in `crates/tessera-core/tests/{fields,types_changes}.rs`.
- Build/stage matching `TASK_BIN`/`TASK_DIST` by the shared procedure, then run integrator checks once. Use the shared combined compile/test exception for the complete Cargo gate, retaining host Cargo/Rustup paths while isolating runtime HOME/XDG; web tests use `task_run` with `TESSERA_TEST_BINARY="$TASK_BIN"`. Smoke a fresh `TASK_RUN/notebooks/integration` notebook on explicit owned HTTP/sync ports, never `.tessera/dev`; use the shared owned browser launcher/CDP procedure.
- Style the lane's pane against docs/design.md only within the requested scope. Commit explicit paths in the owned integration checkout using scoped Git commands and applicable commit rules; landing/shipping needs separate user authorization and the protected-main procedure.
- Retain reports/screenshots in `TASK_EVIDENCE`, then follow shared teardown, leaving harness-managed trees to the harness.
