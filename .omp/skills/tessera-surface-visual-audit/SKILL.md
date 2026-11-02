---
name: tessera-surface-visual-audit
description: "Use when the user asks for a visual or UX audit of one Tessera web surface (sidebar, pane header, outline, table) before changing it."
---

# Tessera surface visual audit

Audit surfaces one at a time, with evidence, before features. Design and wording stay with the main session; never delegate the judgement.

Follow [managing-tessera-task-workspaces](../../../.agents/skills/managing-tessera-task-workspaces/SKILL.md) to prepare/source the audit workspace, matching CLI/assets and run. The RemCard reference checkout is an external prerequisite, not a QA notebook to modify.

## Capture
1. Serve a fresh synthetic seed or permitted detached copy from `TASK_RUN/notebooks/surface`: `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/surface" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"` as a unique named service. Use `/usr/bin/sqlite3` for Mac online backups, strip a copied lock only in the verified owned copy and clear its current-schema `sync_hub` attachment before serving. Verify readiness, actual listeners and `/api/service` build. Never use `.tessera/dev`, :4318, the live registry, or ownership-free PID killing.
2. Use the shared owned browser launcher/CDP procedure with `TASK_RUN/profiles/surface`, then navigate to this run's origin at 1400×900.
3. Take `screenshot({selector})` of the surface at rest, on hover, in its selected state, and in any collapsed or narrow variant. Take `ariaSnapshot(selector, {compact: true})` for structure.
4. Read the markup (`web/src/shell/App.tsx` for the shell) and the CSS (`web/src/styles.css`, `web/src/outline/outline.css`, `web/src/table/table.css`, `web/src/tokens.css`). Compare with remcard's equivalent in `~/src/remcard/docs/design-language.md` and `~/src/remcard/web/src`.

## Report
- Findings grouped by severity: structure, states, density and alignment, collapsed variant, wording. Each cites a screenshot and file:line.
- Measure against docs/design.md: 28 px rows, one left edge, tokens only, Shift = open beside, selection = accent bar + `--selection`.
- End with an ASCII layout proposal and ask whether to apply or change the grouping first. Respect the user's scope notes about what is not ready or remains uncertain.

## Apply
- Edit markup and CSS with tokens only; keep user-facing strings short.
- Rebuild, re-screenshot the same states, drop anything that duplicates a pane-header indicator.
- Update the matching section of docs/design.md and run the requested checks once after edits integrate in the owned source. Commit only explicit owned paths with scoped Git commands and the applicable Conventional Commit rules. An audit/apply request does not authorize push, landing or shipping; use the protected-main procedure only when separately authorized.
- Retain matched before/after captures and structural evidence in `TASK_EVIDENCE`, then follow shared teardown. Name next surfaces without starting new scope automatically.
