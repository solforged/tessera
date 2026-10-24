# Tessera

Tessera is a local-first outline workstation for notes, questions, evidence, tasks and study. You write in an outline of small addressable blocks. Each block is one tile; pages, journals, agendas, investigations and review sessions are different ways of arranging the same tiles.

## Status

- Daily outline, structure, action, learning, library and reading workflows work. Pages, journals, references, search, fields, saved tables and a row of up to four panes share operation-based autosave, undo and conflict handling.
- Tasks support planning, recurrence, projects, clocked work and historical agendas.
- Cards derive from authored notes and vocabulary, with query-backed decks, review sessions and retained scheduling history.
- EPUB books and web articles become immutable snapshots, read beside the outline, highlighted into cited blocks and exported as BibTeX or CSL JSON.
- Questions, perspectives and side-by-side comparison have started; capture and the rest of inquiry follow the [roadmap](docs/roadmap.md).

## Screenshots

The workshop below studies anacyclosis, Polybius's cycle of constitutions. Its quotations come from Evelyn S. Shuckburgh's public-domain translation.

### Perspectives on one idea

Each thinker's position sits under the idea it answers, with its source's siglum in the margin and a constellation of every holder beside the page.

![The Anacyclosis page at Perspectives depth, with six positions marked PLA, ARI, POL, CIC, MAC and IBN beside a constellation of their holders](docs/images/perspectives.png)

### Compare positions

Compare presents selected readings side by side, with source sigla and each account's gist. The readings stay distinct; fields remain in the source outline.

![A reading sheet comparing Plato, Polybius and Machiavelli on anacyclosis, with their source titles and gists](docs/images/compare.png)

### Read and cite sources

A source page sits beside its reader. Highlighting a passage writes an ordinary block on the source page that cites it.

![The Histories source page with one cited highlight, beside the reader with that passage highlighted](docs/images/reader.png)

### Tasks and agenda

Project tasks stay in their outline. Agenda's Tasks view lists them across the week, with a query line for project, state and date filters.

![An essay project's four tasks beside the Tasks view for the week of 12 October](docs/images/tasks.png)

### Review beside the notes

Review a deck beside the notes its cards come from, on a quiet reading sheet with a compact grading strip, interval previews and the card's retained history.

![A revealed card with four grade intervals and its review history beside the study notes that define it](docs/images/review.png)

## What it is for

- **Writing in outlines.** Nest, move, fold and zoom blocks with the keyboard or the mouse. Vim users get real Vim motions inside a block and structural commands across blocks.
- **Reusing thoughts without copying them.** A reference shows the original block's current text. Editing the original updates every place it appears.
- **Questions that change their answers.** An investigation keeps its dated assessments. Accepting a new answer supersedes the old one without erasing it.
- **Distinct accounts of one thing.** Sources, passages and attributed positions stay distinct, so disagreement is visible instead of averaged away.
- **Work and study attached to knowledge.** Tasks, schedules and flashcards live on the blocks they concern, with their history intact.
- **Agents as ordinary clients.** Command-line tools and language-model agents use the same checked operations as the editor. They never write to the database directly.

## Principles

1. Never lose work. Unsaved, saved, conflicted and superseded are different states, and the interface says which one applies.
2. Identity outlives wording. Moving, editing or referencing a block keeps its ID, its cards and its history.
3. Structure is added, not chosen up front. A block can gain a task, a question, a card or a type without becoming a different object.
4. Don't drop a frame. Typing, scrolling and navigation have explicit budgets, measured on large workshops.
5. Quiet and keyboard-first, in a dark or light theme, with every action also reachable by a visible control.

## Documents

### Start here

- [Contributing](docs/contributing.md): reading order, development, builds and checks.
- [How it works](docs/how-it-works.md): the implementation as built, and where to look when something breaks.
- [Domain model](docs/domain-model.md): blocks, capabilities and their rules.
- [Architecture](docs/architecture.md): runtime, editor, storage and sync decisions.

### Using Tessera

- [Usage](docs/usage.md): installation, backups, replicas and agents.
- [Changelog](CHANGELOG.md): what each published version contains.

### Design

- [Design](docs/design.md): browser-client tokens, shell, rows, keyboard, popups and icons.
- Surfaces: [library](docs/surfaces/library.md), [reader](docs/surfaces/reader.md), [tasks and agenda](docs/surfaces/tasks-agenda.md), [journal](docs/surfaces/journal.md), [cards and review](docs/surfaces/cards-review.md), [perspectives](docs/surfaces/perspectives.md), [notes](docs/surfaces/notes.md), [fields and tables](docs/surfaces/fields-tables.md), [settings](docs/surfaces/settings.md).

### Background

- [Vision](docs/vision.md): who it is for and what it must do.
- [Lessons](docs/lessons.md): what the prototype proved and what it got wrong.
- [Performance](docs/performance.md): budgets, the measured baseline and the spikes that decide the stack.
- [Roadmap](docs/roadmap.md): build order and exit criteria.
- [Sync](docs/sync.md): replicating a workshop between your own devices, and what keeps collaboration possible.

## Install

For a running workshop without installation, open the [browser demo](https://tessera.solforged.io).

- **macOS app:** download the [latest release](https://github.com/solforged/tessera/releases/latest), drag Tessera into Applications and follow the [first-launch steps](docs/usage.md#macos-app).
- **Android app:** [build and install an arm64 APK](docs/usage.md#android-app) on a phone with USB debugging enabled.
- **iOS app:** [build and install a development IPA](docs/usage.md#ios-app) on an iPhone with Developer Mode on.
- **Command line:** [build with mise](docs/usage.md#command-line), then run `tessera install` on macOS or `tessera serve` on Linux.

## Acknowledgments

Tessera borrows ideas from tools and thinkers its author admires:

- **Outliners with addressable blocks**, such as Logseq, Roam Research, RemNote, and Tana: outline-first writing, journal days, block references and backlinks.
- **org-mode and org-roam:** scheduled and deadline dates, repeaters, an agenda and clocked work connected to notes.
- **Vannevar Bush's memex:** associative trails that keep the context of discovery close.
- **[FSRS](https://github.com/open-spaced-repetition/py-fsrs)** for memory scheduling, and **Anki's** four-grade review.

## License

Copyright (c) 2026 solforged. [GPL-3.0-only](LICENSE).
