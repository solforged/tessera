---
name: tessera-surface-visual-audit
description: "Use when Sol asks for a visual or UX audit of one Tessera web surface (sidebar, pane header, outline, table) before changing it."
---

# Tessera surface visual audit

Sol wants surfaces audited one at a time, with evidence, before features. Design and wording stay with the main session; never delegate the judgement.

## Capture
1. Service must be on the current build: `bun run --cwd web build`, then `./target/debug/tessera --notebook .tessera/dev serve --assets web/dist` (port 4318; kill any stale PID first, the CLI refuses a second server on the same notebook).
2. Open with `browser.open({url, name, viewport: {width: 1400, height: 900}})`. Tern PiP may refuse on protocol mismatch; headless Chromium is fine.
3. Take `screenshot({selector})` of the surface at rest, on hover, in its selected state, and in any collapsed or narrow variant. Take `ariaSnapshot(selector, {compact: true})` for structure.
4. Read the markup (`web/src/shell/App.tsx` for the shell) and the CSS (`web/src/styles.css`, `web/src/outline/outline.css`, `web/src/table/table.css`, `web/src/tokens.css`). Compare with remcard's equivalent in `~/src/remcard/docs/design-language.md` and `~/src/remcard/web/src`.

## Report
- Findings grouped by severity: structure, states, density and alignment, collapsed variant, wording. Each cites a screenshot and file:line.
- Measure against docs/design.md: 28 px rows, one left edge, tokens only, Shift = open beside, selection = accent bar + `--selection`.
- End with an ASCII layout proposal and ask whether to apply or change the grouping first. Sol replies with scope notes (what is not ready, what he is unsure about); respect them.

## Apply
- Edit markup and CSS with tokens only; keep user-facing strings short.
- Rebuild, re-screenshot the same states, drop anything that duplicates a pane-header indicator.
- Update the matching section of docs/design.md, run `bun test --cwd web`, commit with Conventional Commits wrapped at 72, push.
- Close by naming the next surfaces to audit.
