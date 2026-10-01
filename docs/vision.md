# Vision

Tessera is one person's daily workstation for thinking, deciding, acting and learning. Its primary medium is an editable outline of addressable blocks. Documents, agendas and review queues are views over those blocks, not separate stores.

It is a personal tool, not a commercial product. It must still be dependable enough to hold years of real notes.

## Who it serves

- **The owner,** writing and reading every day, mostly by keyboard, often with two panes open.
- **Agents,** reading context and proposing or making bounded edits through the same operations.
- **Other clients,** such as a command line and later a terminal interface, sharing the same rules.

## Interaction contract

1. **Start by writing.** Opening the app lands in today's journal, ready for text. No form asks where a thought belongs.
2. **The outline is the editor.** Nesting, moving, linking and adding behavior happen in place.
3. **Add structure progressively.** A question can stay a question, become an investigation, gain a next action and later produce flashcards, without a copy at any step.
4. **Useful defaults.** Tasks, questions, cards and common types work out of the box. No schema design or plugin assembly is required first.
5. **Context stays nearby.** A second pane is a full working outline or view, not a read-only inspector.
6. **Keyboard and pointer are equals.** Every action has a visible control and a discoverable shortcut. Vim is optional and complete within a block.
7. **State is truthful.** Saved, unsaved, conflicted, answered, completed and superseded are all different states. A failure never discards work.
8. **Unfinished thinking is content.** Provisional answers, open questions and abandoned approaches are kept, not cleaned away.
9. **Navigation is reversible.** Back and forward restore the page, zoom, scroll position and caret.
10. **Dark and quiet.** Dark from the first paint, including dialogs and errors. Chrome stays out of the way of the text.

## What must be first-class

First-class means explicit relationships, lifecycle rules, operations and views. A label alone does not count.

| Concern | Meaning |
|---|---|
| Blocks and references | Stable identity; references render the original's current text |
| Journals | One root per calendar day in the notebook's time zone |
| Types and fields | Many-to-many membership; typed fields whose values are blocks |
| Tasks | Status, scheduled and deadline dates, repeaters, priority, agenda, clocked work |
| Investigations | An enduring question, criteria, dated assessments, one accepted answer, reassessment dates |
| Sources and positions | Stable source and passage identity; attributed positions that stay comparable and distinct |
| Projects | Bounded outcomes with deadlines, connected actions and open questions |
| Cards | Derived from block text, stable across edits, with full review history |
| Agent changes | Checked, attributable, reviewable and reversible |

## Scope boundaries

In scope for the first usable release: the daily outline, references, types and fields, tasks with an agenda, investigations, cards and review, sources and positions, agent operations with attribution, and backup and restore.

Out of scope until the daily tool works: multi-device sync, collaboration, native mobile, plugin and schema builders, graph visualization and autonomous background agents.

Source ingestion belongs to a separate tool (Bibliotheca). Tessera links to its source and passage identities rather than building a competing catalog.

## How design work happens

Each capability starts from a real task done in the running app beside the conversation. Friction is recorded, behavior is settled, then built, then the same task is repeated. Two standing specimens test the whole: a recurring "which model fits my work" investigation, and reading notes on a book.
