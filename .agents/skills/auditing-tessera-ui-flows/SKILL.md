---
name: auditing-tessera-ui-flows
description: "Audits Tessera UI flows with card-kind captures, screenshots of every dev-app surface, and numbered findings when a clickaround, drivethrough, spacing/consistency pass, or visual bug report is requested; fixes selected findings via lanes and ships when authorized."
---

# Auditing Tessera UI flows

Use this when the user wants a broad pass for inconsistency across surfaces or
card-kind captures for a card/review audit and before/after polish proof. For a
deep audit of one surface, also read repository-local
`tessera-surface-visual-audit`, but give it this pass's private origin rather
than a shared dev port. For a talk-through without fixes, capture and report
findings/proposals only.

## Expected report shape

A markdown table per surface: `# | Spot (shot number) | What I saw | Proposal`,
numbered across the whole report so the user can answer "fix 1, 2, 10, 16".
Regressions first in their own table with the causing commit. End with "biggest
wins in order" and 1–2 open questions. When the user selects fixes, fan out
isolated writer lanes (Fix-fanout below) and verify in private browsers; land or
ship only if separately authorized. Report a `# | Commit | Change` table plus
exercised verification and deviations. Keep evidence/provenance under
`TASK_EVIDENCE`.

## Setup

- Complete
  [`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
  and source its prepared environment. Give every finder/verifier its own
  prepared run, not shared dev :4320 or live :4318.
- Build/stage matching `TASK_BIN` and `TASK_DIST` through the shared build
  procedure; use release for before/after timing.
- **Seeded clickaround content** (since a06e130): seed a fresh private copy
  explicitly at `$TASK_RUN/notebooks/clickaround`, not the persistent registered
  clickaround notebook. It holds the week ending on its seed day: 7 journal
  days, Kitchen renovation and Essay projects with tasks (doing, waiting,
  warning, overdue, completed, clocked work), repeating Routines, Person/Concept
  pages, 24 cards with review sessions, Italian deck, Meditations with 6
  colored highlights and a reading position, 3 catalog records
  (Inbox/Finished), Stoics and Essay sources collections, saved views People,
  Concepts by stage, Kitchen tasks, Italian deck, Not started.
  - Fields: every kind is present. Role/Organization/Last
    contact/Website/Tags/Met at on people; Stage on concepts;
    Rating/Owned/Recommended by on books; Priority; a Meeting template
    (Attendees, Follow-up, Where); a nested Status choice on Hana Okafor.
  - Seed before each clickaround from the owned `TASK_SOURCE`:
    `task_run env TESSERA_BIN="$TASK_BIN" bun scripts/seed/clickaround "$TASK_RUN/notebooks/clickaround"`.
    Never run default `--replace` against the host's registered workshop.
    Highlights are created at seed time, so Resurfaced on the seed day is empty.
    Preserve a stopped pristine baseline before lanes mutate it.
  - Serve privately as a unique named service:
    `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/clickaround" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`,
    or use its matching embedded assets. Record the actual origin and both
    ports; `--sync-port 0` binds an ephemeral loopback listener, not disabled
    sync. Never toggle Sharing/Pair against host Tailscale; any browser
    simulation must be labeled, and real pairing needs separate authorization.
  - **Check the build before capturing**: read `/api/service` on the recorded
    private origin; its build must match the pinned commit. Record
    source/base/binary/assets and fixture provenance in `TASK_EVIDENCE`.
  - Each round starts from a stopped pristine baseline copy. Never reseed the
    host's registered workshop or repair leaked QA state by editing its
    registry.
- **Real data** (only when needed): resolve the requested source read-only,
  allocate `mkdir "$TASK_RUN/notebooks/real"`, then copy with
  `/usr/bin/sqlite3 "file:<source>/notebook.db?mode=ro" ".backup \"$TASK_RUN/notebooks/real/notebook.db\""`
  plus objects. Apply the shared copied-lock/sync-detachment safeguards before
  serving under `task_run`; never mutate the original or live registry. On Mac
  the PATH sqlite3 may be Android's non-FTS build, so use `/usr/bin/sqlite3`.
- Route scoped fixes through the shared integration-owner procedure, retaining
  the numbered findings and per-surface evidence in every lane brief.
- The integration owner runs web tests only after integrating changes, from its
  owned source:
  `task_run env TESSERA_TEST_PORT=<owned-free-port> TESSERA_TEST_BINARY="$TASK_BIN" bun test src`.
  Isolate HOME and all XDG state for Rust/service test runtime too; never ignore
  a real-registry failure as the default. Serialize builds/checks, investigate
  failures and report only exercised verification; finder lanes do not
  build/test mid-flight.
- If node commands die with
  `Cannot find module ~/.config/node/no-process-title.cjs`, prefix with
  `unset NODE_OPTIONS;`.
- Use the shared fresh Chrome for Testing launch with
  `$TASK_RUN/profiles/<width>`,
  `--headless=new --window-size=1440,900 --hide-scrollbars`, and attach to its
  recorded CDP endpoint. Each width/window uses a distinct profile/process.
  Helpers: `tab.click`, `tab.type`, `tab.evaluate`, `tab.clickAt`,
  `tab.screenshot({format:'png',silent:true})` (copy returned temp path into
  `TASK_EVIDENCE`); `tab.addInitScript` takes a source string and `tab.errors()`
  exposes uncaught page errors.

### Browser gotchas

- A page that renders as unstyled Times/Arial with giant icons means a CSS file
  lost a closing brace.
- After an "Open beside" on a phone width, scope every query to `.pane.active`.
- Popups: dump `[role=dialog], [role=menu], [role=listbox], .popup` `innerText`;
  dismiss with Escape on `document.activeElement` plus `document.body.click()`.
- Long pages scroll inside a pane element, not the window: find the first
  `.pane.active *` with `scrollHeight > clientHeight` and
  `overflow-y: auto|scroll` and set its `scrollTop`.
- Compose several phone shots side by side with PIL in the Python kernel to read
  them in one image.
- `TypeError: Cannot read properties of undefined (reading 'cache')` from
  `lookup` means someone passed `notebook.lookup` unbound; use
  `id => notebook.lookup(id)`.

## Phone widths (true size and cover layout)

- `--window-size=412,…` silently yields a ~500 px viewport. Use
  `tab.emulate({viewport:{width:412,height:900,deviceScaleFactor:1,isMobile:true,hasTouch:true}})`.
- Headless Chromium never matches `(pointer: coarse)`. Simulate it two ways,
  both needed:
  1. `tab.addInitScript` (string) overriding `window.matchMedia` to rewrite
     `(pointer: coarse)`, `(hover: none)`, `(any-pointer: coarse)` to
     `(min-width: 0px)` and `(pointer: fine)`, `(hover: hover)` to
     `(max-width: 0px)`.
  2. After load and after every navigation, `tab.evaluate` a pass over
     `document.styleSheets` rewriting each top-level
     `CSSMediaRule.media.mediaText` the same way.
- Confirm with
  `getComputedStyle(document.querySelector('.bottom-nav')).display !== 'none'`.
  On the phone, sidebar-only surfaces (Fields, Settings) need
  `[aria-label="Toggle sidebar"]` clicked first.
- The physical Fold is about 540 CSS px; the emulator about 443. Measure at 412,
  540 and 1440, plus 860 for the unfolded split (the user keeps the spine fold
  at 860; Open beside is disabled there with "Needs a wider window").
- Touch hit areas: under coarse pointer `--target-size` is only 32px; use
  `min-height: var(--touch-target)` (44px) for ≥40px targets.

## Navigating

- Desktop: click `.sidebar button` matched on the first line of `innerText`
  (Today, Agenda, Revisits, Review, Library, Fields, types, Settings). Bottom
  nav `.bottom-nav button`.
- Opening a page by title: click `.global-search`, type into `.picker-input`,
  click the `.picker-row` whose first line equals the title. The palette lists
  content first, then a `Definitions` group.
- Page projections: `.pane.active .pane-header button` with text Read / Outline
  / Compare.
- In-pane controls: `.pane.active button` by `innerText` or aria-label; counted
  tabs read `All\n1`, match on the first line. Several buttons share text
  (`Relation`, `2`): pick the nth.
- Agenda: Day/Week/Tasks tabs; Week header `W43 · 2026-10-19 – 2026-10-25`,
  `Show all hours` at the tab row's right; overdue `Move all` menu. Library:
  `Sources and highlights / Library`, tabs Reading · Inbox · Highlights · More
  (aria `More library views`).
- Fields (sidebar): field list rows open definition pages
  (Format/Hide/Role/Counts as menus, Options, In templates, Used by). Type
  templates live under each type's `Fields` tab. A page's field bed has
  `+ Add field`; clicking a value cell edits it; relation pills open their
  target, the pencil or F2 edits.
- Settings: one scrolling page with a left section list (Preferences, Workshops,
  Backups, Devices, Agent, Agent changes, About). Theme buttons
  System/Light/Dark switch the theme instantly (reset to System afterwards).

## Conventions (what usually drifts)

- Tabs: `.mode-tabs` everywhere. Section heads: mono name, `.section-rule`,
  faint count right.
- Civil dates (settled 2026-10-22): today/tomorrow/yesterday words; weekday+day
  (`Sat 24`) only inside the current Mon–Sun week; ISO everywhere else. Shared
  helper `relativeDate` in `web/src/tasks/relative-date.ts`. Watch for `Oct 19`
  / `06:51 AM` / `FRIDAY, OCTOBER 16, 2026` leaks.
- Counts and machine values in mono (`font: var(--apparatus)`); sentences in
  sans. Sentence case, American spelling (`Color`).
- Links: prose references gilt; holders ink with a `--line` hairline, gilt on
  hover.
- Built-in task field names lowercase (`status`, `deadline`, `project`) next to
  sentence-case user fields; several nouns for one count
  (owners/members/uses/values).
- Desktop-vs-phone heads diverging; content off the page measure (title x≠438 at
  1440).
- Disabled controls without a reason; browser-native selects or validation
  bubbles.
- Two `:has()` flex rules on `.outline-source-line` fighting (`flex-grow: 0` for
  lone facts vs `flex-basis: 0` for `¶N` chips) collapse source-page highlights
  to one character per line (fixed f63c3272).

## Fields UX audit / clickaround (no code changes)

- Compare a fresh private clickaround copy with a private copy of the requested
  real notebook, each under the shared lifecycle and copied-lock/sync-detachment
  safeguards. Real data exposes import artifacts (e.g. Calibre `0101-01-01`
  dates) that seeds do not.
- Surfaces: person page (Role/Organization/Last contact), concept page (Stage
  choice), journal block with `#Meeting` + `Where::` shorthand, Library source
  pages (Show metadata fields in Source actions; Add field; template slots),
  catalog card (Edit details…), type Table/Fields tabs, Fields register +
  field page, 412 px.
- Interactions to exercise: click label vs value, Enter/Escape in a value, Enter
  on empty value, pill click (opens target beside, not an editor), slot click
  per kind, block menu on a field row, Add field → Create field, and measure row
  y before/after selecting another block (sheet collapse shifts content).
- Known structural hotspot (2026-10-12): `web/src/outline/OutlinePane.tsx` ~219
  hides _every_ field entry on source pages unless metadata fields are shown, so
  user-added fields vanish there; filled header-mapped fields (Translator) move
  into `SourceHeader.tsx` pills. Re-check before reporting as still open.
- Retain screenshots/provenance under `TASK_EVIDENCE/fields-clickaround`, hand
  off the exact paths and follow shared teardown.

## Card-kind captures

Use this for card or review UI audits and for before/after proof of card polish.
Never point it at :4318 or the live notebook.

### Notebook copy with real cards

- Select an explicit verified backup read-only and record its
  notebook/schema/build provenance; do not assume a lexically last directory is
  the intended notebook.
- `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/cards" restore <verified-backup>`
  migrates the owned copy to the selected schema. Stop all consumers before
  making a pristine copy for resets after grading. Verify destination, remove
  only a copied `service.lock`, and clear copied `sync_hub` before serving.
- Serve the copy with
  `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/cards" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`,
  after building matching assets in the owned source. Record the exact named
  service/origin/ports; the card browser uses a dedicated task-run profile under
  `TASK_RUN/profiles/cards`.

### Seed one card of each kind over MCP stdio

- Spawn the staged `TASK_BIN --workshop <owned-notebook> mcp` from JS `Eval` with
  `Bun.spawn`, merging `runtime_env` from `TASK_RUN/context.json` over the
  inherited environment. Record its process handle. Write `initialize`,
  `notifications/initialized`, then `tools/call` JSON-RPC lines, and read until
  each id has answered. Never inherit a live workshop through defaults.
- `tessera_add_note {page:'Cell biology', markdown}` with:
  - `A <> B`, with `;;` descriptor children under it;
  - a two-number cloze, one with `::hint`;
  - `Stages >>1.` with numbered children;
  - `Why …? >>>` with bullet children;
  - `A >> B` and `漢字 << reading`;
  - a parent holding `;;` children;
  - a long forward with a `[[Page]]` link and `**bold**`.
- The reply lists the cards it made.

### Capture

- Attach the isolated browser harness from Setup to this run's recorded
  endpoint/origin and emulate 1400x900. Open Review by clicking the nav entry
  whose text starts with "Review"; do not use an unqualified browser.open that
  may select a relay/user session.
- `tab.run` code only sees `document` inside `page.evaluate`. Any `tab.run` call
  times out after 30 s, so run one loop step per call, or expect the timeout and
  keep the files written so far.
- Per card:
  1. Read the kind from `.review-card-kind`; forward cards have none.
  2. Screenshot `.review-session-layout` with
     `(await page.$(sel)).screenshot({path})`.
  3. Press Space until `.review-card-grades` exists; list cards need one Space
     per item, so capture each step.
  4. Screenshot the back, then press `3` (Good).
- Cards popup: on the seeded page, click each button whose text matches
  `^\d+ cards?$`, screenshot `[role=dialog], .popup`, then press Escape.
- Contact sheet: write an HTML file of `<img>` rows per kind in
  `TASK_EVIDENCE/cards`. Open it in the same private browser via `file://` and
  use `page.screenshot({clip,captureBeyondViewport:true})` in ~1000 px slices so
  one image compares all kinds; retain the source shots and contact sheet.

### Things worth measuring

- `getComputedStyle` of each `.review-card-side`: font size, line height and
  `font-variation-settings`. `terse()` mixes sizes across the two sides.
- The positions of bullet and number markers against the line height.

### Teardown

Retain card shots, contact sheet, profile and RPC receipts in `TASK_EVIDENCE`,
then terminate the recorded MCP process and follow shared teardown for its
browser/service resources.

## Fix-fanout

Use `/fix-findings` and `orchestrating-tessera-qa-fixes` for ownership mapping,
fix lanes, phase-end gates and independent browser re-QA. Keep the numbered
findings and capture evidence from this pass in lane briefs; follow the shared
cross-lane contract, tokens-only styling and sentence case.

- Expect cross-lane scope requests (a shared helper, test file or one-line
  hook). Route the change to the owning writer or integration owner; even
  trivial edits do not grant access to another lane's checkout/index. Publish
  shared API/wording decisions in the contract and transfer scoped handoffs.
- Data the row lacks (e.g. logged-work totals) needs a full-stack lane after the
  row lane finishes; don't let a lane fake it.
- The integration owner runs `cargo fmt --all`, `cargo test -p tessera-core` and
  `ts-lint` once after crate changes are integrated: CI runs `fmt --check`
  and `clippy` -D warnings. Build/install under normal host HOME and isolate test
  runtime HOME/XDG; lanes skip checks mid-flight.
- When committing is authorized, assemble coherent area commits (`feat(core)`,
  `fix(tasks)`, `fix(outline)`, `fix(shell)`, `fix(library)`, `fix(fields)`,
  `fix(review)`, `docs`) only in the owned integration checkout with Git bound
  by `-C` or tool `cwd`. Follow the commit hook rather than leave `fixup!`
  commits. Update CHANGELOG Unreleased and applicable `docs/surfaces/*.md` in
  that integration; never rewrite a shared branch/index to fold corrections.

## Land

Only when landing is authorized, use
`landing-lane-patches-around-dirty-peer-trees` and
`shipping-tessera-live-builds`, “Land a change on main”, for protected-main
landing and peer coordination. Rebase only the clean owned integration tree.
Preserve both sides' intent in CHANGELOG conflicts; if a peer cut a release,
keep unreleased entries out of the released section.

## Ship

Only when shipping is explicitly authorized, use `shipping-tessera-live-builds`
for live ancestry, the exact landed SHA, host installation and live-build
verification. An audit or selected-fix request does not imply
shipping/device-install permission.

## Clean-up

Retain reports, screenshots and profiles/traces in `TASK_EVIDENCE`, then follow
shared teardown. Record any retained gallery/trial or unfinished fix tree with
its next owner.
