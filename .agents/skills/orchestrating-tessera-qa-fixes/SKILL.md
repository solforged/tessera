---
name: orchestrating-tessera-qa-fixes
description: "Orchestrates Tessera clickthroughs using QA finder lanes, independent verifiers, isolated fix lanes and re-QA; lands or ships only when the user authorizes those actions."
---

# Orchestrating Tessera QA fixes

This procedure fixed 69 editing findings (2026-10-12, 14 lanes), 43
import-clickaround findings (Plan 0, 7 lanes, shipped as cb0692f), 60
reader/annotation findings (2026-10-15, PR #22 and #24), 41 tag/atom findings
(2026-10-18, 6 finder + 7 fix + 3 re-QA lanes, PRs #64/#66/#67), and 136
animation/modal findings (2026-10-28, 10 finder + 10 fix lanes + 5 re-QA rounds,
PR #93, shipped d2190640). Each pass used one or more rounds of re-QA and landed
on protected main.

## Shared lifecycle and lane ownership

Complete
[managing-tessera-task-workspaces](../managing-tessera-task-workspaces/SKILL.md)
before setting up lanes. Each finder/verifier/re-QA lane gets its own prepared
run, while source-writing lanes transfer scoped handoffs to one integration
owner.

## Find phase (when the user asks for the clickthrough itself)

- Pin the build under test. If the explicit shipped SHA matches the requested
  base, copy `/Applications/Tessera.app/Contents/MacOS/tessera` into `TASK_BIN`
  and use embedded assets; otherwise build/stage a release CLI and matching
  `TASK_DIST` through the shared procedure. Debug builds are not timing
  evidence.
- Baseline notebook: from `TASK_SOURCE`, run
  `task_run env TESSERA_BIN="$TASK_BIN" bun mise-tasks/seed/clickaround "$TASK_RUN/notebooks/base"`.
  Verify the owned destination before removing only a copied/stale
  `service.lock`. Add real sources through a temporary owned service when books
  are part of the pass, using
  `task_run "$TASK_BIN" --workshop <owned-copy> add --wait <epubs> <url>`. Stop
  the baseline service before copying it for lanes.
- Real data: resolve the requested source notebook read-only rather than assume
  `main` or a historical workshop name. For context, the 2026-11-01 pass found
  `restored-oct-14` (7303 blocks, objects folder) rather than near-empty `main`.
  Copy with `/usr/bin/sqlite3` read-only `.backup` plus objects into
  `TASK_RUN/notebooks`; verify the destination, strip only its copied
  `service.lock`, and clear copied `sync_hub` before any serve. Never write the
  live notebook or host registry.
- Write `TASK_EVIDENCE/qa-contract.md`: pinned build/source and run per lane,
  notebook/profile/service/ports, per-viewport browser recipes, coarse-pointer
  simulation (matchMedia plus stylesheet rewrite re-applied after lazy CSS
  loads), rAF-then-setTimeout(0) sampler and report format (id, severity, kind,
  viewport, steps, expected/actual, evidence, cause as file:line, fix idea).
  Chrome for Testing and version-matched native Playwright WebKit are
  prerequisites; use the shared browser-launch/resource-ledger procedure. Finder
  lanes edit no source.
- **Never toggle Settings › Devices › Sharing or press Pair a phone in a scratch
  service.** Both run the host's
  `tailscale serve --bg --https=4319 http://127.0.0.1:<that service's sync port>`
  (off runs `--https=4319 off`,
  `crates/tessera-service/src/sharing.rs:102-131`), which repoints or removes
  the live phone route. Put this in every contract. To exercise the Pair dialog,
  install an in-page `window.fetch` shim (`tab.addInitScript`) that answers
  `POST /api/sync/sharing` and `/api/sync/pairing` in the browser and label
  those screens simulated. Merely loading Settings runs read-only
  `tailscale status --json`. `--sync-port 0` means a random loopback port, not
  off. A finished pass leaves
  `~/Documents/tessera-design/2026-11-01-visual-clickthrough/` (13 finders, 28
  verifiers, 174 standing findings) as a template for harness.md,
  verify-contract.md and report.md.
- **`/usr/bin/sqlite3` only.** The bare `sqlite3` on PATH is Android
  platform-tools', lacks FTS5, and checkpoints/unlinks a running service's WAL.
  Put this in every contract.
- Type into CodeMirror with `tab.press` per key; `tab.type(selector)` re-clicks
  and dismisses pickers. In this harness `browser.open` returns the tab itself.
  A modal popup now makes the page `inert`, so `tab.click` on chrome fails with
  "disabled or inert" until Escape.
- Lanes split by surface and viewport, plus one code-led lane on the shared
  primitives (Popup/Menu/Picker) that confirms each suspicion in the browser;
  that lane finds the cross-cutting root causes.
- Each lane returns 8–15 findings. Save every report to its
  `TASK_EVIDENCE/reports/<Finder>.md` in the Python kernel (`output(name)`),
  parse `### ID: title` blocks, assign every id to exactly one fix lane
  programmatically (assert no gaps/duplicates), and retain `findings.md` with
  the full blocks per lane in the integration owner's evidence root.

## Find-only pass with verifiers

Use when the user asks for a broad bug hunt (note editing, fields, clipboard,
sync, imported material) without fixes, or when findings need independent
confirmation before fix lanes. Earlier passes: 2026-10-12 (16 lanes + 12
verifiers, 69 verified bugs in ~1.5 h; import clickaround 14 lanes + 18
verifiers, 155 of 159 verified,
`~/Documents/tessera-design/2026-10-12-import-clickaround/`) and 2026-10-15 text
entry (20 lanes + 23 verifiers, 72 of 76 verified, 10 data-loss,
`~/Documents/tessera-design/2026-10-15-text-entry-qa/`).

- Harness: retain setup in `TASK_EVIDENCE/harness.md`, including page ids, field
  names and holder ids from the owned copied database. Each prepared lane copies
  the stopped base into its `$TASK_RUN/notebooks/lane`, applies the shared
  copied-lock/sync-detachment safeguards, then starts
  `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/lane" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`.
  Record the actual origin/ports; default viewport is 1568x984.
- Use the shared fresh-browser launch with `$TASK_RUN/profiles/<window>`. A
  second window is a separate process/profile, not two opens of the same
  profile; retain each browser and launcher handle, and keep the same
  origin/profile within persistence checks.
- Focus CodeMirror with `tab.clickAt` (a synthetic click doesn't focus it).
  Server truth: `fetch('/api/pages/<id>')` plus reload. External paste:
  synthetic ClipboardEvent with a DataTransfer. IME: CDP
  `Input.imeSetComposition`. Jitter: rAF sampler of `.outline-pane`
  scrollTop/scrollHeight/caret top, printing changed frames only, on a scrolled
  page.
- WebKit lane alternative: use an explicitly provisioned Playwright WebKit
  matching the source's lockfile-installed playwright-core. Keep tool
  files/browser binaries under `TASK_RUN/tools`, launch its harness via
  `task_run` with an explicit browser path and private context/profile, and
  retain video/traces in `TASK_EVIDENCE`. A missing native WebKit toolchain is a
  prerequisite to report, not a container substitute.
- Spec to cite: `docs/design.md` "Block row" (~347-574) and "Keyboard language"
  (~575-686), `docs/surfaces/*.md`.
- Lanes that paid off: structural keys; inline fields; zoom/pages;
  selection/clipboard/undo; inline text/completions; tasks and cards in notes;
  journal; multi-window sync/offline; widths/visual; menus and palette;
  types/tags/backlinks; randomized sessions (word it as property-based testing,
  never "fuzz"; it found a data-loss bug the hand lanes missed); Playwright
  WebKit vs Chromium (desktop is WKWebView); large-page perf; Vim/settings;
  notes from reader; unicode (graphemes, RTL, NFC/NFD, case folding); page
  lifecycle (merge, delete/restore); Compare/perspectives. For research
  material: perspectives/Compare, questions/assessments, views over entities,
  sources/evidence, site-vs-app visual comparison (serve a separately owned
  `~/src/site` copy with its own private run and owned port).
- Highest-yield bug class in 2026-10: keys typed while an async pick or commit
  is pending (completion create-page, Compare title resolve, reader Add note,
  relation picker) and focus dropping to BODY after a commit. Ask lanes to type
  zero-delay bursts right after Enter or picks and to press ⌘Z / Tab immediately
  after commits. A lane that returns only 1-2 findings needs a concrete, harder
  second round.
- Each lane writes `findings.json`
  (`{id,title,severity,surface,steps,expected,actual,evidence,spec,known,repro_rate}`),
  `ideas.md` and screenshots beneath its own `TASK_EVIDENCE/laneN-<slug>/`; hand
  the exact retained paths to the integrator.
- Write findings and coverage incrementally. A new lane first reads its
  predecessor's findings/coverage, then prepares its own runtime; it never takes
  over an unowned profile, notebook or process handle.
- Verifier contract (`TASK_EVIDENCE/verify-contract.md`): statuses confirmed /
  partial / not_reproduced / spec_mismatch_wrong / duplicate, adjusted severity,
  refined steps, likely `code` path:line; output retained `verify/<name>.json`.
  Spawn verifiers (~2–5 ids each) as each lane finishes; round-2 additions name
  only new ids. Judge cross-lane duplicates explicitly (Undo-4 → TasksText-3
  style). Every verifier uses its own prepared run.
- Merge retained findings/verdicts in eval
  (`TASK_EVIDENCE/findings-merged.json`), generate the appendix table and
  hand-write the themed top of `report.md`: data loss first, root-cause
  clusters, UX themes, what held up, prior bugs fixed/still open. Keep
  source/run/build provenance with the report.
- Retain reports/screenshots/profiles/traces and any gallery handoff in
  `TASK_EVIDENCE`, then follow shared teardown using each lane's exact resource
  ledger.

## Fix lanes

- Give every concurrent fix writer its own owned tree and send scoped
  patches/commits to one integrator. Publish shared primitive APIs (props such
  as `returnFocus`, `dirty`, `modal`) in the contract before call-site lanes
  implement them; file/region ownership is not permission to share a writable
  checkout.
- Lanes edit only, skipping builds/tests/typechecks/formatters mid-flight. From
  `TASK_SOURCE/web`, the orchestrator gates the integrated tree once per round
  (installed `./node_modules/.bin/tsc --noEmit -p .` and
  `-p tsconfig.demo.json`,
  `task_run env TESSERA_TEST_BINARY="$TASK_BIN" bun test src`, and matching Vite
  assets into `TASK_DIST`). Use the shared build procedure rather than symlink a
  peer's node_modules or `src/demo/pkg`; checkpoint explicit scoped files in the
  integration owner's tree.
- Type errors from a lane: revive that lane with the exact error
  (`write agent://<Lane>`), don't fix inline.
- If a lane's final output is only a short note (its report got overwritten by a
  later turn), ask it to resend the full report.
- Recurring fix shapes worth briefing up front:
  - Any frozen text offset or range must be rebased through acknowledged
    text-rewrite receipts (`mapTextOffset`/`rebaseText` in
    `web/src/document/text-patch.ts`).
  - Undo/Redo pressed while an operation is pending must queue in key order.
  - Behavior removal must send the real capability operation and snapshot the
    full prior state in the inverse.
  - Reload in the gap must replay accepted intents through the outbox.
  - Motion: `disabled` on a focused button drops focus to BODY and dims
    everything; use `aria-disabled` + a click guard for transient locks. WAAPI
    `reverse()` on a pending or finished animation rewinds/snaps (cancel and
    play a fresh enter instead). Measuring a row under
    `content-visibility: auto` returns the `contain-intrinsic-size` placeholder;
    set `contentVisibility='visible'` before measuring. WebKit lacks
    `interpolate-size`; JS disclosure glides must retarget while lazily mounted
    content arrives. WebKit never focuses a clicked button, so focus restore
    must target the trigger explicitly.
- Steer lanes that propose changing app-wide defaults or adding migrations back;
  those are the user's decisions.

## Re-QA

- Retain `TASK_EVIDENCE/reqa-contract.md`; each re-QA agent prepares its own
  run, owns distinct HTTP/sync ports and profile, and uses a fresh stopped base
  copy plus the pinned integrated binary/assets (copied into that run, not
  mutable output paths). Read finder/fixer reports at `agent://<Name>` or their
  retained evidence paths. Return
  `{id, status: fixed|partially_fixed|still_broken|regressed, evidence}` plus a
  `new` list.
- Forward each re-QA report's items to the owning fixer as soon as it arrives
  (`write agent://<Fixer>` revives a parked agent with its context); batch
  primitive items until the primitive re-QA lane reports. Rounds shrink fast:
  2026-10-28 went 10 → 6 → 3 → 1 → 1 verification lanes. Watch for data-loss
  regressions introduced by robustness fixes (a dirty popup auto-dismissing on a
  re-rendered anchor lost typed input).

## Authorized commit, land and ship

- The named integration owner assembles coherent area commits under the shared
  ownership/authority procedure. Combine areas when cross-area imports require
  it rather than manufacture broken intermediate commits; follow repository
  signing and commit-message rules.
- If individual-commit checks are required, use explicitly based owned checkouts
  with their own dependency/assets setup under the shared procedure.
- Perform dependent copy/build/serve steps sequentially: a notebook copy and
  `serve` in the same parallel tool batch race, creating an empty notebook
  (migrations from version 1 in the log is the tell).
- For an authorized landing, coordinate through intercom and use
  `landing-lane-patches-around-dirty-peer-trees` plus the protected-main
  procedure in `shipping-tessera-live-builds`.
- For a separately authorized ship, wait for the exact SHA on `origin/main` and
  follow the host shipping procedure; QA runtime isolation must not redirect the
  managed host ship cache or installation.

## Cleanup

- Retain reports, screenshots, profiles/traces and unfinished handoffs in
  `TASK_EVIDENCE`, then follow shared teardown from `TASK_MAIN`. The resource
  ledger must identify any intentionally retained gallery/trial and its next
  owner.
