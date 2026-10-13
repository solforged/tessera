# Notes

A note is a titled page; the [domain model](../domain-model.md#notes) defines its kinds.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Index

Index is a sidebar section after Pinned. Its count is the distinct notes filed, left out at zero. It always lists the built-in kinds in this order:

1. People, Groups, Concepts and Theses: types with those titles.
2. Questions, Sources and Projects: capabilities on the page.

This keeps the notebook's vocabulary visible before anything is filed; the rows never move as kinds fill. Each other type by title and Unfiled follow, listed only while they have titled notes or tagged non-page blocks.

Rows stay on one line, with the name left and a bare mono count right:

| Kind | Count and appearance |
| --- | --- |
| Note kind | Titled notes. |
| Tag-only type | Tagged blocks, with a tag glyph. |
| Empty built-in kind | `--faint`, with no count. |

Note counts and the distinct-note total never include tagged blocks.

The Index heading opens a bounded directory in the same order, with explicit note, source or `N tagged` counts. Tag-only rows open their [member table](fields-tables.md#tables-and-views) directly; other kinds open their finding aid. A saved view sits under the kind whose type it lists, on a hairline elbow and without its table glyph. The section refreshes with the desk counts and disappears rather than go stale when its request fails.

## Finding aid

A kind opens with rubric `INDEX`, its plural in Piazzolla and a mono note tally. A type's Index, Table and Fields modes share the ruled tab strip with live counts. Fields opens [that type's template](fields-tables.md#type-fields-tab), not the global register.

Titles sit under rubric letters with a hairline and a distinct-note count:

| Pane width | Columns |
| --- | --- |
| 840 px or wider | Three. |
| Below 840 px | Two. |
| Below 600 px | One. |

Each note shows two lines of its existing Gloss, else its first non-field prose block, then one populated template field and the live descendant-block count in mono. The Collections finding aid instead shows its member-source count in mono, using the same Library collection query as the collection cards. A title without prose has no empty preview. The batched index read derives ordinary note apparatus from existing data, including field entries, values and headings in block counts.

Only populated jump letters appear. On the touch cover they sit above bottom navigation, with the selected letter on the shared gilt tab rule and compact inline initials in the list. Sort as, diacritic folding, `#` last and alias cross-references retain their filing rules. A title opens its note; Shift or a coarse pointer at least 900 px wide opens it beside.

## Empty kinds

An empty finding aid says `No people yet.` in muted Piazzolla under a hairline, then one sentence on how pages arrive:

- Type kinds are filed from Unfiled.
- Questions and Projects use Make question or Make project in the page menu.
- Sources arrive through the [Library](library.md).

Every built-in kind except Sources offers New person…, New question… and so on, in the empty state or beside the populated finding aid's tally. Creation files the page as one acknowledged batch, creating the kind's type page too when it is missing, then opens the page; Shift-Enter opens it beside. A title that an existing page already has files that page instead, or opens it when it is already of the kind, and the form says so before you submit. The type's own title is refused.

The form opens under a `NEW PERSON` rubric with the title in the page-title face on a hairline and an optional gist line beneath it in the gloss face. The gist becomes the page's first block, which the finding aid shows under the title. A type with template fields lists them in mono. Up to four similar pages, matched by title or alias, follow under Similar pages: one already of the kind opens, any other is filed as the kind.

## Unfiled

Unfiled is a filing queue grouped into With text and Blank, with All, With text and Blank filters and real block/backlink apparatus. Blank can still be referenced and is not a deletion recommendation.

Opening a blank note does not add stored blocks. Add a block starts writing only when chosen.

Each row has File and a menu containing Open, File under a type…, Rename…, Merge into… and Delete…. Desktop and unfolded layouts pair the list with a selected-note inspector and links to its referring pages. The touch cover uses a filing sheet above navigation.

The shared type picker lists existing types and explicitly offers Create type “X” and file. Creation and membership are one acknowledged batch of existing operations. Rename uses the canonical page document; merge and delete retain their existing confirmations and undo rules.

## Sources

Sources is a bibliography, not a second reading shelf. It shows siglum, source title, author byline, format, publisher, publication year when stored, citation key, highlight count and ordinary page-backlink count. Open source notes is the default; Read appears only for sources with a current snapshot and hands off to the [reader](reader.md), and Open Library sits in the ruled strip. Reading progress and invented metadata are absent.

## Note header

A note at its top level shows its kinds above the title in rubric mono capitals, separated by a faint slash (`PERSON / ECONOMIST`). Each opens that kind's finding aid.

The title wraps within its available header width, including unbroken names and URLs, without overlapping the header actions.

A note with aliases shows them under the title: `ALSO` in faint mono, then the aliases in italic Piazzolla at the quote size, separated by faint dots. Then one mono line reads the last ten characters of the note's ID, lower-cased, with the full ID as its tooltip, then `Created 2026-10-06` in the notebook's time zone. The gloss follows as the first row.

Unfiled notes show no kinds. Sources keep their own header; journal days and the Fields page have none.

The Backlinks section appears and its count refreshes when incoming links change, including links to the note's own blocks. It reports the full count after removing links already represented as perspectives or works, groups sources by referring page, shows the first 100 when open, and offers Load more for each further batch. Unlinked mentions of the title and aliases follow it; see [Backlinks](../design.md#backlinks).

## Aliases

Add alias, in the page menu after Gloss and in the palette, adds the Aliases field after the gloss and starts a new value with keyboard focus, ready for the first typed character. `[[` completion and Find name the alias a result was found through as `via Tully`, in faint mono at the row's end.

A hand-typed `[[Name]]` that two or more pages answer to stays unlinked and reads in `--warning` with a dotted underline and a small `?`. Clicking it lists the pages and Create page; the choice links it with the typed wording kept. Imported creators with a shared name read the same way.

Merging leaves the merged page's title as an alias, which the confirmation states in one sentence.

## Starting templates

A Person, Group or Concept type page with an empty template offers `Start from the Person template` in its template area, naming the fields. A type page the app creates with one of those titles starts with it.

## Type icons and names

A type's template offers **Icon and name…**: a compact glyph grid and an editable plural name. The empty name previews the automatic English plural; Reset removes both overrides. Apply records one undoable change on the type page, shared across devices.

The sidebar, Index directory, note eyebrow and table title read the same kind presentation. Book, Article and Collection default to their book, article and shelf glyphs without writing notebook data; other made types use a tag. An unknown glyph also reads as a tag.
