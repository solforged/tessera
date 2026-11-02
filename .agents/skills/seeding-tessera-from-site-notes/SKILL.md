---
name: seeding-tessera-from-site-notes
description: "Imports solforged.io (~/src/site) notes into a Tessera notebook as real primitives (questions, positions, sources, highlights, quotes) when requested for QA or a starting point, and repairs or migrates already-imported data in the live notebook."
---

# Seeding Tessera from site notes

Use when the user wants site notes (`~/src/site/src/content`) in Tessera as QA
material or a starting point, or wants imported data repaired. QA defaults to a
private notebook, never live :4318. Writing/repairing a live notebook requires
explicit authorization for that exact target and import/repair scope after the
dry-run results are available.

## Shared lifecycle

Complete
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
and source its prepared environment. Coordinate read-only access to `~/src/site`
with its owner and retain import manifests/backups in `TASK_EVIDENCE`.

Copy/restore the QA fixture into `$TASK_RUN/notebooks/site` using the shared
copied-lock/sync-detachment safeguards, then start
`task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/site" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`.
Record the actual origin/ports and use the shared fresh-browser launch for
checks.

## Importer prerequisite and historical design

`import_site.py` is not supplied: the `pre-site-questions-20261013T055737`
backup that held it is gone. Obtain and review an actual importer source
artifact before running this procedure; record its provenance and a task-local
copy under `TASK_RUN/tools`. Do not claim this design is an available runnable
tool or silently reconstruct it during a seeding task. If no source is
available, report that prerequisite and leave the target unchanged. The
following documents the importer that worked on 2026-10-13 for 30 questions, 31
propositions, 26 concepts and 220 sources:
`Importer(base_url, out_dir, run_key)`; stages `stage1_pages` (fields,
question/concept/holder pages), `stage2_records`, `stage3_snapshots` (= queue
jobs + `await_jobs` + `locate_all`), `prune_creators`, `stage4_content`,
`stage5_quotes`. Its `SKIP_QUESTIONS`/`IMPORTED_QUESTIONS`/`HOLDER_MAP`
configure selection/mapping. `await_jobs` reads persisted `/api/library/jobs`,
so an authorized target restart can resume with `await_jobs(); locate_all()`
against that same recorded target.

## Source data

- `entries/**` frontmatter: `kind` (note/investigation/project), `form`
  (atom/proposition), `type` (person/concept), `questions`, `relations`
  (supports/qualifies/disputes), `life`, `aliases`, `summary`.
- `questions/*`: `state`, `parent` (one-level nesting). Latin lorem placeholders
  (`cur-tempus-fugit`, `num-veritas-manet`, `quando-quaestio-redit`,
  `quid-est-dolor`) are skipped.
- `src/data/references.json` (CSL-JSON, by `id`) and `passages.json` (`id`,
  `ref`, `quote`, `url`).
- Body syntax: `[[slug|label]]`, citations `[label](@key#passage-id)` or
  `[label](@key "locator")`.
- Concept notes with `## Perspectives` / `### Holder` + lowercase `key:: value`
  lines and `## Where they disagree` / `### Question` + `criterion::` /
  `between:: slug, slug` (slugified holder headings). Skip `<Figure>`, `import`,
  and `<Component />` lines.

## Mapping

| Site                             | Tessera                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| question card                    | page + `set_question {unsettled, parked, review_on:null, accepted:null, parent?}`; `parent` must already be a question when the op applies (order roots first). No 'Part of' text line since build 1d2d3b5.                                                              |
| question `questions:` concepts   | one `Related: [[c]], [[c]].` line on the question page                                                                                                                                                                                                                   |
| proposition (literature)         | position block `[[holder]]` under `Perspectives` (h2) on its most specific question page; Gist = title, Work = `[[source]]`, summary, prose                                                                                                                              |
| proposition holder               | first author of the most-cited source in the body (tie: first cited); authorless source → the source page itself                                                                                                                                                         |
| concept perspective `### Holder` | position on the concept page; `key::` lines → Text fields (`Removed work`, `Paid for`...). Heading like `Karpathy 2017` → real person page via `HOLDER_MAP`. After the positions, `set_subject_criteria` with the perspective keys so Account never becomes a criterion. |
| `source::`                       | **Work** if the holder is among the source's authors, else **Account**                                                                                                                                                                                                   |
| disagreement `### Question`      | block `Q ([[Field                                                                                                                                                                                                                                                        |
| relations                        | child block `[[targetPos                                                                                                                                                                                                                                                 |
| person/concept atom              | page + `add_type`, Gloss = summary, Aliases                                                                                                                                                                                                                              |
| CSL reference                    | `POST /api/library/records/plan {metadata, cover_url:null}` → apply `plan.operations`; `isbn:`/`doi:` ids; volume/issue/page_range now kept                                                                                                                              |
| open-access URL                  | `POST /api/library/jobs {url, target_source}`; skip `.pdf`; poll the jobs list                                                                                                                                                                                           |
| passage quote                    | normalize quotes/dashes/whitespace, find in passages, `cite` with UTF-16 offsets → highlight block on the source page                                                                                                                                                    |
| citation in prose                | `[[highlightId                                                                                                                                                                                                                                                           |
| one per proposition              | `((highlightId))` row + `set_quote` from `GET /api/blocks/{hl}/quote-snapshot`                                                                                                                                                                                           |

## Gotchas

- `#word` anywhere in block text (titles like `Episode #2255`, URL fragments
  `/#--x`) mints a type page: write `no.` instead and strip URL fragments from
  the URL field (Tessera bug, reported 2026-10-13).
- Article ingest scrapes bylines (`2021 June 08`, `UK United Kingdom`,
  `21 others`, GitHub handles, `Authors`) into Author and sometimes mints
  unlinked Person pages: `prune_creators` deletes those value blocks and orphan
  pages.
- Within one batch, `after` must be a sibling: restore the section pointer after
  nesting loops. Keep stage 4 in one batch (<1.8 MB) so a validation error rolls
  everything back.
- `set_subject_criteria` bumps the page revision; nothing else in the batch may
  touch the root afterwards.
- Raw batches are not undoable via Agent changes: back up the explicit target
  with
  `task_run "$TASK_BIN" --workshop <verified-target> backup "$TASK_EVIDENCE/before-site-import"`
  first, and retain the manifest beside it. For a live target, re-read
  service/notebook identity and confirm the authorized scope immediately before
  the first write; do not infer that a successful QA dry-run authorizes it.
- Navigating the web UI headless: `.global-search` → click `text/Pages` →
  `tab.type('input[placeholder*="Find in pages"]', title)` → Enter; `/page/<id>`
  URLs do not route.
- ~40 of 220 web jobs fail (403, PDF, no readable text, non-UTF-8); ~50 quotes
  sit in snapshots the extractor emptied; both fall back to source links.

## Verify

- `/api/index` kind counts, `/api/questions?parent=`, per-page `capabilities`
  (position/question/relation/quote), `/api/positions?subject=` criteria.
- Report the retained backup, manifest, holder choices
  (`TASK_EVIDENCE/report.json`), failures and actual written
  target/build/source. Preserve requests/receipts and browser evidence, then
  follow shared teardown; the live service lifetime is not owned by this import
  task.
