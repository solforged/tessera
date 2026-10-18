# Atoms, tags and fields

Working note, 2026-10-17. It resumes the 2026-10-14 conversation that proposed one user-facing primitive and ended without a decision. When it is built, its rules move into [domain-model.md](../domain-model.md#vocabulary), [design.md](../design.md) and [fields-tables.md](../surfaces/fields-tables.md), and this file is deleted. The storage findings it depends on are in `data-model-audit.md` on the `claude/data-model-audit-tana-logseq-e3b04f` branch; that note should land beside this one.

## Verdict

The storage model already is the atom model: one block table, behavior as capability rows, type pages with field templates, fields whose values are blocks, and a deck for every tag that has cards (`card_query.rs::tag_decks`). What is unfinished is the surface. The interface uses seven words (block, page, note, kind, type, field, capability) for what a person experiences as three, creates things through twelve hardcoded kind lists that each offer a different subset, cannot give a new tag a template at the point of use, and never tells anyone that `#arabic` on a card is an Arabic deck.

## Today

- **Words.** The [vocabulary](../domain-model.md#vocabulary) names Block, Page, Note, Kind, Type, Field and Capability, and the rule says only these words appear in the interface. Kind (Person, Concept) and Type (`#book`) are the same thing to a user. Task, question, card and project are capabilities, which the user cannot name or type.
- **Creation.** `/` opens a hardcoded array (`web/src/outline/completions.tsx` `slashItems`) of task commands and Image; it offers no tag, field or deck. `@` schedules. `#` completes type pages and creates a provisional page for an unknown name (`storage.rs` `provisional_pages`). The creation slip offers note, question, task, card and source (`create/CreateSlip.tsx` `primaryKinds`) and a More menu read from the note index. Review's header offers New card and New deck. A deck made from a tag is listed but never explained, and its Edit and Delete actions are the only text that admits it exists.
- **Kind lists.** `notes.rs` (`TYPE_KINDS`, `TYPE_ICONS`, `CAPABILITY_KINDS`), `built_in.rs` (type schemas and the five-type ensure loop), `notes/kinds.ts`, `create/kinds.ts`, `create/request.ts`, `create/CreateSlip.tsx`, `fields/templates.ts` (`startingTemplates`), `outline/commands.ts` (`cardItems`) and the `'fields'` exclusions in `OutlinePane`, `PageMerge`, `MetadataCreators`, `SpreadPane` and `IndexPane`.
- **Templates.** A type page edits its template in place. A tag typed for the first time has none, and the template-grows-from-use offer needs a second member before it appears.
- **Help.** No syntax or shortcut sheet exists. The command registry (`shell/App.tsx`) is the only list of bindings.
- **Tag identity. Engine built.** Canonical tags address a page ID; legacy input normalizes on write, and renaming a tag leaves member text alone (audit R1).

## Proposal

### Three words

| Word | Meaning | Replaces in the interface |
|---|---|---|
| Atom | Anything written: a line, a task, a person, a question, a day, a book. Zooming it opens it. | Block, page, note |
| Tag | What an atom is. A tag has a page listing every atom with it, and may carry a template of fields. Some tags are built in and bring behavior. | Kind, type, capability |
| Field | A named, typed value an atom carries, read as its tag's template says or on its own. | Field |

The schema keeps `block`, `page_id`, `memberships` and the capability tables. The interface stops saying page, note, kind, type and capability. Journal days keep their name; a day is an atom the calendar owns.

One sentence describes the model: a tag says what an atom is; built-in tags bring behavior, yours bring fields.

### Built-in tags

Every built-in behavior is a tag the user can type, and the registry lists them first.

| Tag | Brings | Today's mechanism |
|---|---|---|
| `#task` | checkbox, status, scheduled, deadline, priority, repeat | task capability, `/Todo`, ⌘Enter |
| `#question` | revisit date, criteria, assessments | question capability |
| `#project` | outcome, deadline, active state | project capability, Space o |
| `#source` | snapshot, reading state, citation key | source capability, Library ingest |
| `#person`, `#group`, `#concept`, `#thesis` | template, Index filing | type pages by title |
| `#book`, `#article`, `#collection` | template, shelf icon, exports | type pages by title |

Rules:

- Typing a built-in tag adds the behavior; the shortcut or command that adds the behavior today still works and adds nothing to the text. Either source keeps it, as [memberships](../domain-model.md#types-and-fields) already do for text and manual types. Removing the tag or the behavior deactivates without erasing history, as task removal does today.
- A built-in tag that has a glyph renders as its glyph, not as a text pill: the checkbox is the `#task` pill, the question mark is the `#question` pill. Tags without a glyph render as pills after the text, as `#book` does today.
- Built-in tags cannot be deleted, merged or renamed, and their pages are system pages. Existing type pages with those titles become the built-in tags, as the roadmap's stage 10 promised.
- Cards are not a tag. A card is a face an atom gets from `>>`, `<<`, `<>` or a cloze, and the atom's tags decide which decks hold it. `#card` would add a face with no front and back, so it is refused with the sheet's line about operators.
- Assessments, positions, highlights, quotes, images and arguments stay as they are. They are made by an action on a passage or a question, never by naming, and so are not tags.

### One registry, one picker

A core read lists every tag: built-in ones from the schema, then the user's, each with its template, member count and card count. Every surface that offers a kind reads it, and the hardcoded lists above are deleted:

- `#` completion in text.
- `/Tag…` in the slash menu, which also gains `/Field…` (the owner's template slots and then every field) and loses its Image-first ordering.
- The creation slip's primary and More kinds.
- A tag table's New … button.
- Review's deck list, which is the registry filtered to tags with cards, with saved decks after it.
- Find or create, whose create row names the tag when the query starts with `#`.

### A tag born at the point of use

Typing `#arabic` where no tag exists creates the tag page in the same change, as now. The new part is the receipt: one quiet line under the atom, in the register's mono, reading `#arabic is new · Add fields · Open`, dismissed by typing on. Add fields opens the type page's template editor as a popup on the atom, so the template is written while the first member is in view. Open goes to the tag page. The line appears once per tag per workshop.

The template-grows-from-use offer stays and keeps its two-member threshold.

### Decks read as tags

- The outline's `1 card` count becomes `1 card · #arabic` when the atom has tags, and `1 card · untagged` otherwise. Clicking the tag opens Review scoped to it.
- Review's header reads `Tag a card to make a deck. Save a deck for other filters.` New deck stays for saved decks.
- A tag page's Cards tab offers Review, scoped to the tag.
- The domain model documents tag decks beside saved decks.

### Fields

**Reading 1 is built.** The alternatives considered were:

1. **Fold into Index.** The Fields register is the last row on the Notes shelf in the sidebar and Index directory, with a field glyph and live definition count. It is a fixed register row, not a tag registry kind, so kind pickers never offer it. The sidebar foot button is gone; tag templates, routes, commands and menus stay intact.
2. **Keep the section.** Fields stay a top-level register, on the argument that a field is defined once and used by many tags, so it is not naturally found under any one of them.

Reading 1 removes a word from the chrome and matches Tana, where fields live in supertag definitions and a global list exists but is secondary.

### Roots and where things live

- A storage root stays for a day, a tag page, a book, a person created from a field, and an atom hoisted out of its day. The user never chooses a root and never sees the word page.
- An atom born on today stays there. Its parent is provenance; its tag page is its address. Untagged lines stay on the day.
- Hoisting an atom to its own root leaves a reference in the day. It is offered, never required.
- Titles of roots stay unique under the current folding. Revisiting that waits for a reason.

### The sheet

`⌘/` (and `?` in normal mode) opens one sheet with two columns: syntax and bindings.

Syntax, each with its one-line meaning and an example:

| Write | Meaning |
|---|---|
| `#tag` | What this atom is. A new name makes a new tag. |
| `name:: value` | A field on this atom. |
| `>>`, `<<`, `<>`, `{{c1::…}}` | A card: forward, reverse, both, cloze. Its tags are its decks. |
| `@friday`, `@due monday` | Schedule or deadline on this atom. It is not a task until it is tagged one. |
| `[[` | A reference to another atom. |
| `/` | Everything else: tags, fields, task states, images, views. |

Bindings come from the command registry so the sheet cannot drift. On phones the sheet is a full-height panel.

First-use hints, one line under the atom in the receipt's style, shown once per workshop each: the first `>>` (`a card · tag it to put it in a deck`), the first `::` (`a field · its tag can carry it as a template`), the first new tag (the receipt above).

### Tag identity

Built in step 7: tags are canonical as `#[[id|Title]]`, memberships key on `type_id`, and the alias refreshes lazily when its atom is next edited. Pills read live titles, existing picker choices insert IDs, and receipts normalize hand-typed tags without losing the caret. Rename touches only the tag page. Migration 051 and `tessera check` verify and repair derivation.

## Decisions

- **Three words in the interface: atom, tag, field.** Block stays in the schema.
- **Capabilities are built-in tags.** Agreed 2026-10-17. Capability tables stay in the engine; the tag is how a person names and types the behavior.
- **Cards stay syntax, not a tag.** The tag decides the deck.
- **Glyph tags render as glyphs.** A checkbox is a pill.
- **`@friday` only schedules.** Agreed 2026-10-17. A dated atom with no `#task` is an appointment on the Agenda, with no checkbox. In the engine the task capability's status becomes optional and `#task` sets it to todo; today the `@` menu adds the capability as a todo, so step 4 changes that.
- **Pages are not dropped.** Roots stay as storage and the user never picks one.
- **Titles stay unique.**
- **Fields fold into Index.** Reading 1 is built; see above.
- **Supertag is not a word Tessera uses.** The primitive is stronger than Tana's name for it, and the name carries Tana's look, which Sol does not want.

## Open questions

- Does `#source` typed by hand make sense without a snapshot? Proposed: it creates a source with no snapshot, the state Library gives a manual entry today.
- Which built-in tags does the creation slip show first on each platform? Proposed: `#task`, `#question`, note (untagged), card, `#source`, then the registry.
- Where the tag registry read lives: the note index (`notes.rs`) already computes most of it.

## Build order

1. **Vocabulary.** This draft's words into `domain-model.md` and `design.md`; interface strings follow surface by surface. No schema change.
2. **The sheet and first-use hints.** The sheet is built: `⌘/`, Commands and the Mac's Help menu, bindings read from the registry. Still to do: `?` in Vim normal mode, and the first-use hints.
3. **One registry and one picker.** Core read, then `#`, `/Tag…`, `/Field…`, the slip, tag tables, Review and Find read it. Delete the hardcoded lists. The new-tag receipt and template popup.
4. **Built-in tags. Engine built.** `#task`, `#question`, `#project` and `#source` derive their records from membership, with removal receipts and retained history. Built-in tag pages have canonical names and refuse deletion, merging away and renaming. Task status is optional for appointments; Agenda includes them and task views do not. Check reports and repairs missing tagged records. Glyph rendering remains the web part of this step.
5. **Decks read as tags.** Badge, Review header, Cards tab, docs.
6. **Fields into Index. Built, reading 1.** The fixed Fields row closes the Notes shelf in the sidebar and directory, with the register's live definition count.
7. **Tags addressed by ID. Built.** Migration 051, normalization receipts, ID-keyed memberships, lazy aliases and check repair are built. Pills read live titles, completion inserts IDs, and editor normalization preserves the caret and undo.
