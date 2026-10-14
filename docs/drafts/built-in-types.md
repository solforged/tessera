# Built-in types and their fields

Working note. When it is built, its rules move into [domain-model.md](../domain-model.md#kinds) and [fields-tables.md](../surfaces/fields-tables.md), and this file is deleted.

## Today

- **Built-in kinds:**
  - `person`, `group`, `concept` and `thesis` are recognized by exact title key (`notes.rs:15-20`).
  - `question`, `source` and `project` come from capabilities.
  - `book`, `article` and `collection` are recognized by name for shelves and icons.
- **Fields are created on demand** by whichever surface needs them, Title Case, found again by name ignoring case. The core's library planner, the web's source details, Collections, Add perspective, Add gloss and the starting templates each keep their own list.
- **Templates are never required.** Nothing marks a field as expected, and nothing counts a member that lacks one, except Fill missing fields when asked.
- **Starting templates** for person, group and concept apply only when a type page first appears through a page command. Their relation fields have no Links to types, although the domain model says they link to Group, Person and Source.
- **Creator is a name list.**
  - `@creator` is the union of fields named author, editor or translator (`entity_query.rs:400`).
  - The same list is repeated in exports, the siglum, the citation key, the library facets and the notes summary.
  - A future `director` field could not count as a creator without code.
- **Holder exists only for perspectives**, as the position's first link. A thesis is a type with no template.
- **Promised but not built:**
  - system types that cannot be deleted or merged
  - a type refining a built-in kind
  - a built-in Form choice field

## Proposal

### One schema, owned by the core

A single table in the core says which fields each built-in kind carries. It replaces the starting templates, the library planner's labels, the web's source-detail field map and `fields/templates.ts`. Each field has:

- a lowercase name
- a kind
- Links to types, for relations
- what it **counts as**, if anything
- a level: **required**, **expected** or **available**

| Kind | Required | Expected | Available |
|---|---|---|---|
| person | | aliases, lived (span), affiliated with → group | |
| group | | aliases, active (span) | |
| concept | | aliases, coined by → person, group, coined in → source | |
| thesis | | | |
| book | author → person, group | editor, translator, published, publisher, identifier, language | subtitle, edition, series, pages and the other catalog fields |
| article | | author → person, group, site, published, URL | as for book |
| collection | | | |

author counts as **creator**, and editor counts as creator when a work has no author. translator counts as **contributor**: listed after the creators, never in a byline, siglum or sort. coined by and coined in count as **originator**.

### What required means

Nothing is ever refused or rewritten. Required is a promise of attention:

- A required field is always in the type's template. Its Remove button is disabled with the reason, such as “Books require author”.
- A member without a nonblank value shows the faint slot whatever the field's Hide setting, and its row reads as incomplete, such as “needs author”.
- The type's table and Index count incomplete members (“3 need author”), and the count adds the field's `is empty` filter, which lists them. A separate missing-required filter waits for a type that requires two fields.
- Expected fields start in the template and can be removed or reordered like any other. Available fields are created when a value first needs them, as today.

### Counts as

A definition may declare what it counts as, from a fixed vocabulary the core extends: creator, contributor and originator.

- `@creator` becomes the union of fields that count as creator, and `@contributor` the union of those that count as contributor. A future `director` or `showrunner` counts as creator with no code change.
- Siglum, citation key, Desk and notes summary read creators through it, in field order, author first.
- BibTeX and CSL still map known names to their own roles: author, editor and translator. Another creator field exports in the closest CSL role, falling back to author.
- This is not the presentation role (standfirst, attribute, prose, citation). In the field menu it reads **Counts as…**.

### Ensuring

Built in stage 1 as `ensure_built_in_fields`, a synced, operation-based change like the library creator backfill. It needs no setting: once everything is in place it finds nothing to do.

- **When it runs:** on open, and after a sync clone is adopted.
- **For each live built-in definition**, it recases the name and gives a relation with no Links to types the types it expects, where those pages exist.
- **For each built-in type page that exists**, it appends missing required fields to the template. Expected fields still arrive only with a starting template.
- **It never changes an existing field's kind,** which stays a reviewed interpretation. A notebook whose `lived` is text keeps it.
- Still to come: running when a built-in type page is created. Counts-as needs no ensuring, since built-in fields read theirs from the schema.

### Lowercase names

Built in stage 1. Every creation site takes names from `built_in.rs`, and the ensuring change recases older definitions with ordinary text edits, so the rename syncs. Every lookup already ignored case.

## Decisions

- **Holder stays with perspectives.** A thesis gets no holder field. A perspective's holder remains its first link, which costs a note-taker nothing to write. Several holders' perspectives on one proposition, and counterperspectives between them, belong to the perspectives work, not to type schemas.
- **Required is rare.** Only book requires author. Everything else is expected, so taking notes by hand never starts with a list of gaps.
- **Author leads.** Translators count as contributors, shown after the author and never in bylines, sigla or sorting.
- **Built-in fields cannot be renamed.** A change of case is allowed, so existing Title Case names can become lowercase. Identity stays the name, so no setting is needed.
- **Type pages appear on demand.** The schema exists in every notebook, but a person, group, concept or thesis page and its fields are created only when the first such note is.

## Build order

1. **Built.** The schema table, lowercase names, ensuring on open and the rename refusal. The web's starting-template list mirrors the schema.
2. **Built.** Required: slots, incomplete counts in Table and Index, the field's empty filter, and the disabled Remove with a core refusal.
3. **Built.** Counts as: the definition property, its operation, and `@creator`, `@contributor`, sigla, bylines, search and exports reading it. Built-in fields count as the schema says, read rather than stored. The source header's editable byline still lists only author, editor and translator.
4. Several holders on one proposition, with the perspectives work.
