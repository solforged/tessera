# Roadmap

Each stage ends with an exit test: a real task done in the running app. Stages are ordered, not dated.

## 0. Foundations

- One vocabulary and a first schema from the [domain model](domain-model.md).
- The block-level invariants in [lessons](lessons.md) as executable tests before features. Invariants for a capability, such as card progress or accepted assessments, are written first in the stage that adds it.
- Corpus generator and benchmark harness with the [performance](performance.md) budgets.
- Spike 1 (backend operations) and spike 2 (editor), which settle the core read path and the editor stack.

Exit: a 10,000-block page loads within budget and single-block operations commit within budget, in tests.

Status: done. Spike 1 passed. Spike 2 chose CodeMirror over ProseMirror and Solid over React.

## 1. Daily outline

- Today's journal on open; pages; Enter, Backspace, Tab and move with stable IDs.
- Folding, zoom, breadcrumbs and two working panes.
- Back and forward that restore page, zoom, scroll and caret.
- References with completion, readable rendering, backlinks and opening beside.
- Search with an outline preview and drill-down into a result's children.
- One command palette that also lists shortcuts.
- Vim inside blocks and structural Vim across them.
- Operation-based autosave, undo across saves, the IndexedDB outbox, conflict handling.
- Headings, types as tags, and spike 3 (windowing).

Exit: write, rearrange, navigate away and reopen for a week of real notes without losing work or place, within budget on a 2,000-block page.

## 2. Structure

- Types with field templates and typed fields whose values are blocks.
- Type pills with manual and text-derived membership.
- Type tables with sorting and filtering.
- Structured queries by type, field, task state, dates and text, saved as views.
- Settings.

Exit: record a reading list with authors and dates, then sort, filter and save it as a view.

Status: done. Fields, templates, type tables with sorting and filtering, saved queries, manual membership from a pill menu, a Fields destination and notebook settings (time zone, Vim) are in. Task-state and date filters are available in Agenda's Tasks view. The [design](design.md) language applies to the shell, outline, tables and capability surfaces.

## 3. Action

- Tasks with status, scheduled and deadline dates, repeaters and priority.
- Quick date entry (`@friday`, a shortcut, a popup with quick picks).
- Agenda in the journal; projects with outcomes and actions; clocked work sessions.

Exit: plan a small project, work it over several days with clocked time, and find the result from the agenda.

Status: done. Browser proof planned a language-model project, recorded clocked work and notes, completed work in historical journals, advanced a recurring task across adjacent days, reopened and undid a completion without duplicating history, and saved and restored a project task query. Agenda rows open the canonical source beside the historical day. A parity pass added ⌘Enter and `[] ` task creation, the `@` date popup on any block, quick capture in Agenda, and a journal agenda that summarises the day when collapsed. A keyboard pass added the `/` command menu, `@due` deadlines, the ⌘⇧Enter status menu and a Space leader for planning, clocking and cards.

## 4. Learning

- Cards from `>>`, `<<`, `<>` and numbered clozes, with forgiving, visible syntax. `::` stays field shorthand.
- Review with grades, next-interval previews and return to source.
- Keep progress or start over when a card's text changes.
- Saved review decks backed by queries.

Exit: study cards from real reading notes and a vocabulary deck in a language being read, correct a card from review, and keep its history.

Status: done. Browser proof studied Greek vocabulary and attention-study notes, including both card directions and independent numbered clozes. It saved and edited source/field-filtered decks, corrected a source beside review, retained progress and shown-text evidence, reset progress without erasing history, and restored the selected deck, queue and session through navigation and reload.

## 5. Library and reading

- Fields that sources need: ordered creators with roles (author, editor, translator) as references to person pages; partial dates such as a bare year; URL and identifier kinds for ISBN, DOI and arXiv; values supplied by a snapshot's extracted metadata until an authored value replaces them, with reset back to the extracted value.
- A source is a page with a source capability and a source type (`#book`, `#article`), so its metadata is ordinary fields ordered by the type's template. A compact header shows creators, year, reading state and progress instead of one outline row per field.
- `tessera-ingest`, written fresh with Bibliotheca as reference only. EPUB first, then web articles: immutable, content-hashed snapshots; original files in the notebook's object store; passages with their own search index. Ingestion jobs with retry and resume run in the service.
- Library joins the sidebar as a saved table over source types, with Inbox, Reading, Finished and Abandoned views.
- A reader pane beside the outline, with reading position and progress.
- Highlighting a passage writes an ordinary block on the source's page that cites it; citations pin source, snapshot and passage. A triage view lists unprocessed highlights across sources.
- Cards from highlights.
- Export: stable citation keys, with BibTeX and CSL JSON for a source, a selection or a saved view.

Exit: ingest a book and an article, read a chapter in the reader, take notes that cite passages, study cards made from them, and export the book as BibTeX and a reading list as CSL JSON. Afterwards the Bibliotheca repository is archived.

Status: done. Browser proof ingested The Tudors (EPUB) and Karpathy's RNN article through the CLI, jumped to chapter 1 from Contents, read until the source moved from Inbox to Reading, highlighted a sentence with a note and a `>>` card beneath it, turned an article highlight into a cloze, studied both cards in Review, worked the Highlights triage, and exported the book as BibTeX and the library as CSL JSON (`meyer2010tudors`, `scharre2018army`, `karpathy2015unreasonable`). Fields gained URL and identifier kinds and year-only dates. The Bibliotheca repository is archived at `~/src/archive/bibliotheca`.

## 6. Capture

- A save-to-Tessera browser extension that sends the current page, or a selection as a highlight, to the loopback service.
- RSS and Atom feeds polled by the service, with new items arriving in the Library inbox.
- Newsletters arriving in the same inbox.
- Book search and download providers, such as OPDS catalogues, written fresh.

Exit: subscribe to two feeds and a newsletter, save an article and a highlighted selection from the browser, find and ingest a book through a provider, and triage a week of arrivals from the inbox.

## 7. Inquiry and evidence

- Questions, criteria and dated assessments with one accepted answer.
- Attributed positions compared side by side, supported by passages.
- Assessments that cite positions and passages.

Exit: run the "which model fits my work" investigation twice, a month apart, and trace each answer to its evidence.

Progress: questions are open, answered, parked or unsettled, accept one answer, carry a review date and record aporia. Perspectives name a holder and subject with a gist and a source siglum, and a Compare pane sets them side by side. Criteria and assessments that cite positions and passages remain.

## 8. Trust

- Change history with actors; agent plans previewed and applied atomically.
- Spike 4 (runtime and concurrency) and spike 5 (eight-hour soak).
- Backup and restore from the app, including the object store.
- Command line for capture, ingestion, search, queries and agent context.

Exit: an agent does bounded work on a real project; every change is attributed and reversible; a restore from backup loses nothing acknowledged.

Progress: `tessera backup` and `tessera restore` cover the database and object store from the command line, landed with the local install pass, and Settings › Backups makes a backup from inside the app. Restore from the app, change history with actors, agent plans and the soak and concurrency spikes remain.

## 9. Perspectives

- Ideas: break a book or paper down into an outline of its ideas, each citing its passages.
- Perspective lenses: flip between holders' positions on an idea, then record your own.
- Side-by-side comparison of concepts and of how different thinkers classify them.
- More sources: papers as PDF, tweets and threads, and highlight imports from Kindle and X.
- Agent-assisted study: cards and quizzes drawn from a source's passages, with a study plan against a date.

Exit: break a chapter into ideas, link two authors' positions on one idea and state your own, then be quizzed on the chapter by an agent and review the resulting cards.

Progress: perspective lenses and comparison arrived with stage 7's positions. Titled pages read as prose with page glosses, a depth dial from gloss to full, and an apparatus margin whose constellation links holders and pages. Idea breakdowns, more source types and agent-assisted study remain.

## Not planned

Multi-device sync, collaboration, mobile apps, plugin and schema builders, graph visualization and autonomous background agents. Each may come later; none blocks daily use.
