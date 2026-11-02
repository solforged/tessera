---
name: capturing-tessera-publication-screenshots
description: "Captures public Tessera app screenshots from a seeded throwaway notebook in headless Chromium when solforged.io entries or Tessera's README (docs/images) need current images."
---

# Capturing Tessera publication screenshots

Use this when an entry in `~/src/site` or Tessera's README needs current Tessera
captures.

## Shared lifecycle

Complete
[managing-tessera-task-workspaces](../managing-tessera-task-workspaces/SKILL.md)
and source its prepared environment at the explicit capture commit. Retain
originals, captions and provenance in `TASK_EVIDENCE` before copying approved
publication outputs.

## Rules

- Never use the live notebook, the installed app, or ports 4317/4318/4320/5173.
- Use public content only: the anacyclosis concept with its six holders, sources
  from the site's `src/data/references.json`, Polybius 6 from LacusCurtius, and
  Machiavelli's _Discourses on Livy_ (Gutenberg 10827, Ninian Hill Thomson
  translation). Never show odd, political or private material (e.g. Gideon's
  Spies or anything from the user's private library), and check the sidebar's
  Recent list and Views.
- Seed CSL sources with `Siglum:: <citation-label>` so Tessera's marks match the
  site (IBN, not KHA).
- Before capturing, ask the ~/src/site omp session over intercom whether it is
  already capturing Tessera. It keeps a public anacyclosis notebook
  (perspectives, sigla, Polybius 6 reader); existing finals at
  `~/Documents/solforge-process/<date>/tessera-current/final/` may be reused
  after confirming their provenance/content and permission. Do not share its
  mutable notebook, profile or service. New capture originals belong in
  `TASK_EVIDENCE`.

## Notebook

- **Site entries, at a pinned commit:** select the capture checkout through the
  shared procedure rather than create a fixed `/tmp` worktree. Build the release
  CLI with `embed-web` and matching web assets, stage the executable at
  `TASK_BIN`, then serve with
  `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/public" serve --port <owned-free-http> --sync-port <owned-free-sync>`
  (embedded assets) or `--assets "$TASK_DIST"`. Record actual ports and origin.
  `--sync-port 0` is ephemeral, not disabled sync. Seed through
  `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/public" add <public-url>`,
  the owned origin's API, or Library Add; never run `install` for a capture.
- **README showcase notebook:** use only a verified public-content source.
  Allocate the fresh destination with `mkdir "$TASK_RUN/notebooks/showcase"`,
  then copy without touching the source:
  `/usr/bin/sqlite3 "file:SRC/notebook.db?mode=ro" ".backup \"$TASK_RUN/notebooks/showcase/notebook.db\""`
  and copy its objects there. Apply the shared copied-lock/sync-detachment
  safeguards before serving via
  `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/showcase" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`.
  Never toggle host Sharing/Pair in this QA service.

## Seeding through the API

`POST /api/batches` with header `Origin: http://127.0.0.1:<port>` and a body
`{actor:{kind:'client',name:'readme-showcase'}, idempotency_key, operations}`.
Generate IDs as 26-character Crockford ULIDs. Each operation needs the
`base_revision` taken from the `revisions` of the previous result.

- `create_page {id,title}`; `insert {id,parent_id,after,text,heading}`.
- Write page links as `[[ID]]`. A `[[Title]]` inserted through the API stays
  literal text.
- Tasks: `set_task` with a full TaskState (`status`, `scheduled`,
  `scheduled_time`, `deadline`, `deadline_time`, `warning_days`, `repeater`,
  `priority`, `completed_on`); `set_project {outcome,deadline,status}`.
- Clocked work: `start_work`, then `stop_work`. Completion: `complete_task`.
- Cards come from block text (`>>`, `<>`, `{{c1::}}`). Create review history
  with `grade_card` using back-dated `reviewed_at`. Rows come from
  `POST /api/cards/query {selection:'all'|'due'|'new'}`, and each row's `card`
  carries `revision`, `definition_revision`, `front` and `back`.
- A journal's ID: `GET /api/journal/<date>` returns the root block. Fetch its
  rows with `GET /api/pages/<id>`.

## Capture

- Use the shared fresh Chrome for Testing launch with
  `$TASK_RUN/profiles/<target>` and attach to its recorded CDP endpoint, not the
  user's browser. Set the target viewport below, wait for content/fonts and copy
  each screenshot's returned temp path into `TASK_EVIDENCE`; keep the browser
  and launcher handles in the ledger.
- Resolution by target:
  - Site entries: 1440x900 CSS viewport at device scale 2 (1.25 was too
    low-res). Save lossless light/dark PNGs in `TASK_EVIDENCE/final`; copy
    approved finals to
    `~/Documents/solforge-process/<date>/tessera-current/final/` only as the
    requested publication handoff, and never delete retained finals.
  - README: 1440x900 with `emulate deviceScaleFactor 1.25`, giving 1800x1125
    PNGs. Retain originals in `TASK_EVIDENCE` and copy selected images to
    `docs/images/*.png` only in the owned writer checkout. Write one caption per
    image, with alt text describing what it shows.
- Theme: `localStorage.setItem('tessera.theme','dark'|'light')`, then reload.
- `tab.click` on sidebar buttons and `tab.type` can time out. Instead read the
  element's box with `tab.evaluate`, then `tab.clickAt(x,y)`, with
  `keyDown('Shift')` around the click to open in the other pane; type with
  `tab.run(({page}) => page.keyboard.type(...))`.
- Find or create is `role/button[name="Find or create"]`, then fill
  `role/textbox[name="Find or create"]` and press Enter.
- Before each shot, move the mouse to a corner, await `document.fonts.ready`,
  then call `page.screenshot({path})` inside `tab.run`.
- Shots that worked for the README: project page beside Agenda > Tasks with a
  query line such as `[[Project]] show:open @..fri`; study notes beside Review
  with an answer revealed and Review history expanded (grade cards across
  several past days so intervals show months).
- Inspect every image for loading states, cropping and off-topic content, and
  retake any that fail.

## Finish

- Site: captions name the pinned commit, theme and "public example notebook".
  Retain the capture manifest in `TASK_EVIDENCE`. Before an authorized site
  commit, verify every Tessera hash in `src/content` is still on `origin/main`;
  coordinate with the site's owner rather than write its shared checkout.
- README: when an edit/commit is authorized, commit README.md and selected
  docs/images from the owned writer tree; remove only explicitly superseded
  images. This is docs-only, so do not run `mise run ship`. Check each published
  image at
  https://raw.githubusercontent.com/solforged/tessera/<sha>/docs/images/<name>.png
  only after publication is authorized/completed.
- Retain shots, captions, public-notebook provenance and browser profile in
  `TASK_EVIDENCE`, then follow shared teardown. Coordinate any intentionally
  retained gallery with its next owner; never delete retained finals.
