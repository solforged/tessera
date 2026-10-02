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

## 3. Action

- Tasks with status, scheduled and deadline dates, repeaters and priority.
- Quick date entry (`@friday`, a shortcut, a popup with quick picks).
- Agenda in the journal; projects with outcomes and actions; clocked work sessions.

Exit: plan a small project, work it over several days with clocked time, and find the result from the agenda.

## 4. Learning

- Cards from `::`, `>>` and clozes, with forgiving, visible syntax.
- Review with grades, next-interval previews and return to source.
- Keep progress or start over when a card's text changes.
- Saved review decks backed by queries.

Exit: study cards from real reading notes and a vocabulary deck in a language being read, correct a card from review, and keep its history.

## 5. Inquiry and evidence

- Questions, criteria and dated assessments with one accepted answer.
- Sources and passages linked to Bibliotheca; attributed positions compared side by side.
- Assessments that cite positions and passages.

Exit: run the "which model fits my work" investigation twice, a month apart, and trace each answer to its evidence.

## 6. Trust

- Change history with actors; agent plans previewed and applied atomically.
- Spike 4 (runtime and concurrency) and spike 5 (eight-hour soak).
- Backup and restore from the app.
- Command line for capture, search, queries and agent context.

Exit: an agent does bounded work on a real project; every change is attributed and reversible; a restore from backup loses nothing acknowledged.

## 7. Reading and perspectives

- Passages promoted from Bibliotheca become ideas in an outline of the book or paper.
- Perspective lenses: flip between holders' positions on an idea, then record your own.
- Side-by-side comparison of concepts and of how different thinkers classify them.
- Agent-assisted study: cards and quizzes drawn from a source's passages, with a study plan against a date.

Exit: read a chapter, promote its key passages, link two authors' positions on one idea and state your own, then be quizzed on the chapter by an agent and review the resulting cards.

## Not planned

Multi-device sync, collaboration, mobile apps, plugin and schema builders, graph visualization and autonomous background agents. Each may come later; none blocks daily use.
