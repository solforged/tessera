# Tessera

Tessera is a local-first outline workstation for notes, questions, evidence, tasks and study. You write in an outline of small addressable blocks. Each block is one tile; pages, journals, agendas, investigations and review sessions are different ways of arranging the same tiles.

## Status

- Daily outline, structure, action, learning, library and reading workflows work. Pages, journals, references, search, fields, saved tables and two panes share operation-based autosave, undo and conflict handling.
- Tasks support planning, recurrence, projects, clocked work and historical agendas.
- Cards derive from authored notes and vocabulary, with query-backed decks, review sessions and retained scheduling history.
- EPUB books and web articles become immutable snapshots, read beside the outline, highlighted into cited blocks and exported as BibTeX or CSL JSON.
- Questions, perspectives and side-by-side comparison have started; capture and the rest of inquiry follow the [roadmap](docs/roadmap.md).

## Screenshots

The notebook below studies anacyclosis, Polybius's cycle of constitutions. Its quotations come from W. R. Paton's public-domain 1923 translation.

### Perspectives on one idea

Each thinker's position sits under the idea it answers, with its source's siglum in the margin and a constellation of every holder beside the page.

![The Anacyclosis page at Perspectives depth, with six positions marked PLA, ARI, POL, CIC, MAC and KHA beside a constellation of their holders](docs/images/perspectives.png)

### Compare positions

Compare presents selected readings side by side, with source sigla, shape marks beside the holders and each account's prose. Authored questions sit below the sheet; fields remain in the source outline.

![A light reading sheet comparing Plato, Polybius and Machiavelli on anacyclosis, with their source titles, prose and an authored question below](docs/images/compare.png)

### Read and cite sources

A source page sits beside its reader. Highlighting a passage writes an ordinary block on the source page that cites it.

![The Polybius Book 6 source page with its metadata and one cited highlight, beside the reader with that passage highlighted](docs/images/reader.png)

### Tasks and agenda

Project tasks stay in their outline. In Agenda's Tasks view, one query line filters by project, state and dates, and each term becomes a removable chip. Add condition brings task, source and field filters into one searchable picker.

![An essay project's tasks beside the Tasks view filtered by the chips show:open, the project and a date range](docs/images/tasks.png)

### Review beside the notes

Review a deck beside the notes its cards come from, on a quiet reading sheet with a compact grading strip, interval previews and the card's retained history.

![A revealed card with four grade intervals and its review history beside the study notes that define it](docs/images/review.png)

## What it is for

- **Writing in outlines.** Nest, move, fold and zoom blocks with the keyboard or the mouse. Vim users get real Vim motions inside a block and structural commands across blocks.
- **Reusing thoughts without copying them.** A reference shows the original block's current text. Editing the original updates every place it appears.
- **Questions that change their answers.** An investigation keeps its dated assessments. Accepting a new answer supersedes the old one without erasing it.
- **Several accounts of one thing.** Sources, passages and attributed positions stay distinct, so disagreement is visible instead of averaged away.
- **Work and study attached to knowledge.** Tasks, schedules and flashcards live on the blocks they concern, with their history intact.
- **Agents as ordinary clients.** Command-line tools and language-model agents use the same checked operations as the editor. They never write to the database directly.

## Principles

1. Never lose work. Unsaved, saved, conflicted and superseded are different states, and the interface says which one applies.
2. Identity outlives wording. Moving, editing or referencing a block keeps its ID, its cards and its history.
3. Structure is added, not chosen up front. A block can gain a task, a question, a card or a type without becoming a different object.
4. Don't drop a frame. Typing, scrolling and navigation have explicit budgets, measured on large notebooks.
5. Quiet and keyboard-first, in a dark or light theme, with every action also reachable by a visible control.

## Documents

### Start here

- [Contributing](docs/contributing.md): reading order, development, builds and checks.
- [How it works](docs/how-it-works.md): the implementation as built, and where to look when something breaks.
- [Domain model](docs/domain-model.md): blocks, capabilities and their rules.
- [Architecture](docs/architecture.md): runtime, editor, storage and sync decisions.

### Using Tessera

- [Usage](docs/usage.md): installation, backups, replicas and agents.

### Design

- [Design](docs/design.md): browser-client tokens, shell, rows, keyboard, popups and icons.
- Surfaces: [library](docs/surfaces/library.md), [reader](docs/surfaces/reader.md), [tasks and agenda](docs/surfaces/tasks-agenda.md), [journal](docs/surfaces/journal.md), [cards and review](docs/surfaces/cards-review.md), [perspectives](docs/surfaces/perspectives.md), [notes](docs/surfaces/notes.md), [fields and tables](docs/surfaces/fields-tables.md), [settings](docs/surfaces/settings.md).

### Background

- [Vision](docs/vision.md): who it is for and what it must do.
- [Lessons](docs/lessons.md): what the prototype proved and what it got wrong.
- [Performance](docs/performance.md): budgets, the measured baseline and the spikes that decide the stack.
- [Roadmap](docs/roadmap.md): build order and exit criteria.
- [Sync](docs/sync.md): replicating a notebook between your own devices, and what keeps collaboration possible.

## Install

For a running notebook without installation, open the [browser demo](https://tessera.solforged.io).

- **macOS app:** download the [latest release](https://github.com/solforged/tessera/releases/latest), drag Tessera into Applications and follow the [first-launch steps](docs/usage.md#macos-app).
- **Android app:** [build and install an arm64 APK](docs/usage.md#android-app) on a phone with USB debugging enabled.
- **Command line:** [build with mise](docs/usage.md#command-line), then run `tessera install` on macOS or `tessera serve` on Linux.

## Acknowledgments

Tessera borrows ideas from tools and thinkers its author admires:

- **Outliners with addressable blocks**, such as Logseq, Roam Research, RemNote, and Tana: outline-first writing, journal days, block references and backlinks.
- **org-mode and org-roam:** scheduled and deadline dates, repeaters, an agenda and clocked work connected to notes.
- **Vannevar Bush's memex:** associative trails that keep the context of discovery close.
- **[FSRS](https://github.com/open-spaced-repetition/py-fsrs)** for memory scheduling, and **Anki's** four-grade review.

## License

[MIT](LICENSE).
