# Domain model

Everything a person writes is a block. Behavior is added to blocks as capabilities, each with its own table, rules and history. Indexes such as links and full-text search are derived and can be rebuilt.

## Vocabulary

| Term | Meaning |
|---|---|
| Block | Addressable authored text with one parent and a position among its siblings |
| Page | A named root block |
| Note | A titled page, with the blocks beneath it as its content |
| Kind | What a note is about: a built-in kind such as Person or Concept, or a type you define |
| Journal day | A root block for one calendar date in the notebook's time zone |
| Reference | `[[id]]` or `[[id\|alias]]` in a block's text, pointing at another block |
| Link | The indexed occurrence of a reference; derived |
| Type | Reusable membership, such as `#book`, with an optional field template |
| Field | A typed reading of value blocks, such as Author or Read on |
| Capability | Behavior attached to a block: task, question, assessment, card, source, position, project, note |
| Change | One committed operation, with its actor and the revisions it produced |

Only these words appear in the schema, the API, the code and the interface.

## Blocks

A block has an ID (ULID), parent, page, ordinal, text, optional heading level (1 to 3), revision, archive flag and an optional deletion event. Roots have no parent. Page titles and journal dates are unique among live roots.

Rules:

- **Split** keeps the original ID on the left part. Children stay with it.
- **Merge** keeps the destination ID. It refuses when the source has history that cannot move, such as reviewed cards.
- **Move** keeps the ID and the whole subtree.
- **Archive** hides; **delete** tombstones with a shared deletion event; **restore** needs that event and the exact revision. **Purge** is explicit and refuses to destroy review history.
- Every write checks the revision it was based on. A mismatch writes nothing.

Parentage gives a block its reading context. A question beneath a source is about that source. Agent context always includes ancestors.

## References and links

A reference renders the target's current text. Editing the target updates every reference. A link row records source, target, alias and occurrence order; repeated references stay distinct. Backlinks come from links. A reference to a deleted block renders as unresolved and keeps its raw ID.

Whether some references should freeze a quotation instead of following edits is an open decision.

## Types and fields

A block can have many types. Membership records whether it came from the text (`#book`) or was added manually; either keeps it.

A field is defined by a block on the Fields system page, which every notebook has. Its name is the block's text. Its kind is text, number, date, checkbox, choice, instance, URL or identifier; text unless set. Options of a choice field are child blocks of the definition. A field entry is a block whose whole text is one reference to a definition, so it renders as the field's name; the entry's parent owns the field and the entry's children are the values. Typing `Author::` in the editor produces such an entry. Values are plain blocks read through the field's kind; a value that does not fit shows a problem but is never rejected or rewritten. Date values link to the journal day or spell out the date; a bare year or year and month is a valid date for sources dated no more precisely. Choice values link to their option. URL values are absolute `http` or `https` addresses. Identifier values read an ISBN, DOI or arXiv ID in its usual spellings and normalize it to `isbn:` with 13 digits, lowercase `doi:` or `arxiv:`, so the same work matches however it was written.

Changing a field's kind changes only how values are read. Owner counts include entries with no values and count each owning block once; archived or deleted entries and owners do not count.

A type may carry a template: an ordered list of fields that its table shows first and its members' field sheets offer as empty slots. Fields present on members appear after the template, so a template is never required; Fill missing fields on the type page writes empty entries for members only when asked.

## Queries and views

A query selects blocks by type, text search or field ownership, filters by fields, sorts by title, creation, update or a field, and limits the result. A field-only query considers blocks owning any named field. "Is present" requires a field entry, including one with no values. "Is set" requires nonblank value text; "is empty" requires none. Unreadable values still count as set. Several values satisfy a value comparison if any of them does; "is not" holds only when none matches. Missing and unreadable values sort last. Fields used by filters remain table columns even when all their values are empty.

A view is a saved query with a name and a revision. Views are not blocks; saving and deleting them are operations like any other, so they are attributed and undoable. A type table is the unsaved query for that type's members.

## Tasks

A task capability adds status (todo, doing, waiting, done, cancelled), scheduled and deadline dates with optional times, warning lead, repeater and priority. Dates are local civil dates; times are `HH:MM` labels, not timestamps. Scheduling after a deadline is valid. Removing the capability deactivates it without erasing its history.

Completion records the exact planning snapshot and explicit completion date. A nonrecurring task becomes done; a recurring task stays on its original block and advances its dates. Fixed repeats advance one interval, catch-up repeats skip to the first interval after completion, and after-completion repeats count from the completion date. The scheduled date is the anchor when present, otherwise the deadline. Month/year repeats clamp to the last valid day; the signed separation between scheduled and deadline dates stays intact. Completion never archives. Undo reverses the exact latest occurrence only while its resulting task state still matches.

Clocked work sessions retain their start, end, note and revision. Only one unreversed session may run in a notebook. Completion, cancellation, removal and hiding the running task require an explicit stop first; stop and completion can commit atomically. Reversing a work command retains its audit record.

Task queries compose source type/text/field constraints with task status, priority, project ancestry and independent date ranges. Unfinished-or-recent selection includes unfinished tasks or an unreversed completion in the inclusive context-date range. Filtering precedes the outer result limit. The client query line resolves type and project titles to canonical IDs and relative dates to civil dates; field predicates remain separate from its text syntax. Named task views retain the full query, including its date context, rather than a textual query.

An agenda takes the displayed civil date, never an implicit device date. It merges schedule, deadline, warning, overdue, unplanned and completion reasons into one row per canonical source. A completion on that date uses the latest occurrence's planning snapshot and a done projection, not the next recurring plan. Cancelled tasks are excluded. Opening a row edits the original block; the journal contains no copied tasks.

## Investigations

A question capability makes a block an enduring question with an optional review date. Criteria are blocks beneath it. An assessment capability turns any block into a dated answer to a question. At most one assessment per question is accepted. Accepting a new one supersedes the old one, which stays readable. An assessment may also record aporia, that no answer holds yet; it is dated and cites its evidence like any other.

A question is in one of four states:

| State | Meaning |
|---|---|
| Open | The default: no accepted assessment yet |
| Answered | An accepted assessment exists |
| Parked | Paused; it accepts nothing new until resumed |
| Unsettled | Open by design: it recurs or may end in aporia, collects dated assessments and returns on its review date |

Stored with the question are whether it is unsettled, whether it is parked, its review date and which assessment it accepts. The state is derived in this order: parked, then unsettled, then answered when an accepted assessment exists, otherwise open. Answered is never stored, so it cannot disagree with the assessments. Accepting an assessment on an unsettled question records the current reading without settling it. Resuming a parked question returns it to whatever the rest of the rule gives. Export writes the derived state as the site's `state`.

## Sources, passages and positions

A source is a page with a source capability. Each ingestion of the same source (a URL or a file) whose bytes differ creates a new snapshot, identified by its content hash and never modified. A snapshot holds the document's structure and its passages: headings, paragraphs, footnotes and other units, each with a locator. Original bytes live in the notebook's object store, addressed by SHA-256; passages, structure and reading position live in the database. Passages are evidence, not authored blocks: they are never edited. Writing about a passage creates a block that cites it, and a citation names the source, snapshot and passage, so it keeps pointing at the exact text read even after a newer snapshot exists.

A source's metadata is ordinary fields. A value extracted from a snapshot fills its field until an authored value replaces it; resetting the field shows the extracted value again, which is never discarded. A source keeps one citation key once assigned, and export renders BibTeX or CSL JSON from its fields. Reading state (inbox, reading, finished, abandoned) belongs to the source; the reading position belongs to a snapshot, and a source's progress is that position as a share of its current snapshot's text. Opening a citation is not reading and changes neither.

The reading position is navigation state, not an authored change: it is stored per snapshot, is not undoable, and does not add change rows. The first recorded reading of an inbox source changes its state to reading through an ordinary attributed batch. A citation jump must not call the reading-position endpoint.

Citation keys are assigned once at ingestion and never recomputed when fields change. The suggestion combines the ASCII-folded lowercase family name of the first author (otherwise editor, site or `anon`), the publication year (otherwise `nd`), and the first non-stopword title word. Only letters and digits remain; collisions gain `a` through `z`, then `aa` and onward. Authored keys start with a letter, contain at most 64 letters, digits, underscores, colons or hyphens, and are unique among active sources ignoring case.

Every source has a siglum, a short mark as in a critical edition. An authored Siglum field wins when its trimmed value is one to four letters; it is upper-cased, and invalid values are ignored. Otherwise it is derived from the current fields: the first three letters of the first author's family name, else editor, site or the title's first word containing letters. Unicode letters are kept, non-letters are skipped and the result is upper-cased; shorter names use what they have. The siglum, its full letter-only basis and whether it is authored are derived on reads, never stored, so editing an author changes the default mark. CSL JSON exports it as `citation-label`. Pages that show several sources extend a later colliding derived siglum with further letters of its basis name, in order of first appearance (`THO`, `THOM`, `THOMA`); once the basis runs out they append `2`, `3`, … . Authored sigla never change.

A highlight is an authored block on the source's page that cites a passage. It takes children, types, fields and card syntax like any other block. A highlight with no non-blank children, no card and no incoming reference is unprocessed. Marking a highlight processed or unprocessed overrides that rule until the mark is cleared; it is the only stored triage state. Because passages never change, a passage citation is a frozen quotation by construction.

A position is an attributed claim: who holds it, about which question or subject, supported by which passages. A position capability marks an ordinary block as one; its holder and subject are derived from the block's text and place, never stored. The holder is the page its first link points to. The subject is the block or page its second link points to, else its nearest ancestor question, else its page; so a position can sit under a highlight on a source page and still be filed under the concept it is about. Its fields are ordinary children: by convention Gist (its one-line summary), Work (the source it names, which gives its siglum; otherwise the first passage cited beneath it) and whatever criteria the positions on one subject share. Positions on the same subject are compared side by side and never merged. Assessments cite positions and passages, so a conclusion can be traced to its evidence.

A page's gloss is an entry for the Gloss field among its top-level blocks: the one- or two-sentence hover form shown under the title and in reference previews. It is an ordinary field, created on first use.

These map the three kinds of knowledge in the [vision](vision.md): a fact is an ordinary block, with a passage when it came from reading; someone else's view is a position; your own conclusion is an assessment. A perspective lens is a view of positions grouped by holder.

## Projects

A project capability gives a block an outcome, an optional deadline and active, done or cancelled status. Tasks anywhere beneath it are its canonical actions; nested tasks report their nearest active project capability. A completed project's capability remains active until explicitly removed. Completing a project does not complete its tasks or reassess questions beneath it. Removing the capability retains its history and block identity.

## Notes

A note is a titled page: a root block of kind page. Journal days and the Fields page are not notes. The blocks beneath the title are the note's content; there is no separate note record or copy. Blocks inside a note keep every behaviour of their own, so a note can hold tasks, cards, questions and positions.

### Kinds

A kind says what a note is about. These are built in:

| Kind | Marked by | Meaning |
|---|---|---|
| Person | `#person` | An individual, such as an author or a thinker |
| Group | `#group` | A collective: an organisation, a school, a dynasty, a people |
| Concept | `#concept` | An idea, term or phenomenon, explained and compared |
| Thesis | `#thesis` | A claim you hold, stated as the title and argued beneath it |
| Question | A question capability on the page | An enduring question; see Investigations |
| Source | A source capability on the page | Something read, watched or listened to |
| Project | A project capability on the page | A bounded outcome |

Person and Group are entities: the pages that a position's holder and a source's creators refer to. Person, Group, Concept and Thesis are system types that every notebook has, like the Fields page; they take templates and fields like any type, and cannot be deleted or merged. A notebook that already has a type with one of those titles keeps that page, with its members, fields and template, as the built-in kind. Question, Source and Project come from capabilities and need no tag.

Types you define are kinds too, listed after the built-in ones. A note can have several kinds and is filed under each; a note with none is unfiled. Tasks and cards are not kinds. They belong to blocks within notes, and Agenda and Review are their places.

A source's form is a built-in Form choice field: book, chapter, article, paper, report, post, thread, video or web page, with more options added as for any choice field. Lookup and ingestion fill it, and export writes it as the CSL type and BibTeX entry type.

### State

A note is working or settled. Working is the default and is not stored. Settle records that you stand behind the note as written; Reopen returns it to working. Editing a settled note does not reopen it; the note's apparatus shows that it changed after settling.

### Revisits

A note comes back only when it has a revisit date. On a page that is also a question, the revisit date is the question's review date; there is one date, not two. A question block within a page that has a review date comes back as itself.

From its revisit date onward a note waits in the notes queue in Review, earliest date first. It is reviewed in the ordinary outline, with its sources and backlinks at hand. A revisit ends in one of three ways:

| Action | Effect |
|---|---|
| Revisited | Records the revisit and sets the next date, or none |
| Later | Moves the date without recording a revisit |
| Settle | Settles the note and clears its date |

Revisits have no grade and no scheduler. They judge the note, not your memory of it, so the next date is chosen rather than computed. Each action is an attributed operation that undo reverses, and each writes a revisit event; the note's last revisit is its latest Revisited event. Revisit events are authoritative history, kept like review events.

A note capability on the page holds the stored state and the revisit date. A page without one is working and has no revisit date.

### Index

The index lists notes by kind, each kind with its count, and opens a finding aid of that kind's notes by title. It is derived from kinds and is never stored.

## Cards

Cards derive from block text: `front >> back` is forward, `front << back` is reverse, and `front <> back` makes both directions. A trailing `>>>` takes the non-empty child outline as its answer; a trailing `>>1.` reveals direct children in order, with each child's subtree, before one grade for the list. The front must be non-empty. `::` remains field shorthand. Numbered clozes use `{{c1::answer}}` or `{{c1::answer::hint}}`; repeated numbers form one unit. The source block plus a role key (`forward`, `reverse`, `cloze:c1`, `multiline`, `list`) identifies a card, so wording and child edits keep progress. Escapes, code and references shield literal syntax. Mixed or malformed operators produce diagnostics rather than guessed cards. Removing markup deactivates the unit. Review events record the shown text, grade, scheduler version and state before and after; a reset is an event, not an erasure. Scheduling uses FSRS-6 with default parameters, 90% retention and deterministic whole-day intervals. Reviewed cards acquire FSRS memory by replaying historical grades; historical evidence remains intact.

Only authored non-root blocks derive cards; page titles and journal dates do not. Derivation runs in the text transaction and changes definition revisions without rewriting scheduling state. Removed or malformed markup deactivates units; restoring a role or numbered cloze reuses its ID and progress. Archive and deletion hide cards from queues without destroying units or evidence.

Splitting at the end leaves cards on their original source. An interior split cannot divide active card syntax; a start split cannot move a reviewed card onto a new identity. Merging away a source with any retained review event is rejected even after its markup is removed. Task and project history impose the same source-identity protection.

Grading checks the card revision, definition revision and exact shown front/back. Optional review sessions retain open, finished or abandoned state; closing one never discards grades. A reset retains history, and reset-plus-grade commits both events atomically. Due queues include new cards after reviewed due cards, with stable tie ordering. Saved decks are revisioned card queries over canonical sources, not copies or separate card stores.

A review session excludes cards already graded in that session. Deck selection, queue selection and session identity are navigation state, not card ownership. A grade submitted from a stale or changed presentation is rejected without an event; the client must obtain and show the current card before another grade. Pending delivery and confirmed rejection are distinct, and neither is a successful review.

## Settings

A notebook has settings: its time zone and editing preferences. Setting one is an operation like any other.

## Changes and attribution

Every committed operation writes a change row: actor (person, agent name or client), operation, affected IDs and resulting revisions, and an optional reason. Agents may submit plans that are previewed, then applied atomically under an idempotency key. Undo works by applying an inverse operation, so history remains linear and inspectable across clients.

## Derived data

Links, full-text search, type membership from text, card definitions and field readings are derived in the same transaction as the text that produces them. Definitions can be rebuilt from blocks while retaining their role identities. Card schedules, review evidence, task occurrences and work sessions are authoritative history; rebuilding derived data never recreates or resets them.

## Open decisions

- Whether a block reference can freeze its target's text. Passage citations are already frozen.
- How much change history to keep, and whether old assessments become immutable.
- Configurable task keywords beyond the five fixed states.
- Whether blank blocks persist or exist only in drafts.
- How concept and taxonomy comparison is modelled: types, positions about a concept, or a capability of its own.
- Whether vocabulary cards need anything beyond ordinary cards, such as language, part of speech or inflection fields.
- How newsletters arrive: a polled mail folder, a forwarding address or feeds only.
- Whether a type you define can refine a built-in kind, such as Philosopher as a kind of Person, so its members also file under Person.
- How a thesis page answers a question. An assessment must sit beneath its question, and a thesis page is a root.
- Whether Revisited proposes a next date from the interval since the previous revisit.
