# Domain model

Everything a person writes is a block. Behavior is added to blocks as capabilities, each with its own table, rules and history. Indexes such as links and full-text search are derived and can be rebuilt.

## Vocabulary

| Term | Meaning |
|---|---|
| Block | Addressable authored text with one parent and a position among its siblings |
| Page | A named root block |
| Journal day | A root block for one calendar date in the notebook's time zone |
| Reference | `[[id]]` or `[[id\|alias]]` in a block's text, pointing at another block |
| Link | The indexed occurrence of a reference; derived |
| Type | Reusable membership, such as `#book`, with an optional field template |
| Field | A typed reading of value blocks, such as Author or Read on |
| Capability | Behavior attached to a block: task, question, assessment, card, source, position, project |
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

A field is defined by a block on the Fields system page. Its kind is text, number, date, checkbox, choice or instance. Options of a choice field are child blocks of the definition. A field entry is a block whose children are the values. Values are plain blocks read through the field's kind; a value that does not fit shows a problem but is never rejected or rewritten. Date values link to the journal day. Choice values link to their option.

Changing a field's kind changes only how values are read.

## Tasks

A task capability adds status (todo, doing, waiting, done, cancelled), scheduled and deadline dates with optional times, warning lead, repeater and priority. Completing a recurring task records an occurrence and advances the dates. Completion never archives. Clocked work sessions belong to the task and keep their start, end and note.

## Investigations

A question capability makes a block an enduring question with an optional review date and a retired state. Criteria are blocks beneath it. An assessment capability turns any block into a dated answer to a question. At most one assessment per question is accepted. Accepting a new one supersedes the old one, which stays readable. Retired questions accept nothing new.

## Sources, passages and positions

A source capability links a block to a Bibliotheca source and snapshot. A passage capability links to a specific passage. A position is an attributed claim: who holds it, about which question or subject, supported by which passages. Positions on the same question are compared side by side and never merged. Assessments cite positions and passages, so a conclusion can be traced to its evidence.

## Projects

A project capability gives a block an outcome, an optional deadline and a status. Tasks beneath it are its actions. Questions beneath it are its open questions. Completing a project does not reassess its questions.

## Cards

Cards derive from block text: `front :: back`, `front >> back` and clozes. A card's identity is its block plus a stable key anchored in the text, so editing wording keeps progress. Removing the markup deactivates the card. Review events record the shown text, grade, scheduler version and the state before and after. A reset is an event, not an erasure. Scheduling starts with SM-2.

## Changes and attribution

Every committed operation writes a change row: actor (person, agent name or client), operation, affected IDs and resulting revisions, and an optional reason. Agents may submit plans that are previewed, then applied atomically under an idempotency key. Undo works by applying an inverse operation, so history remains linear and inspectable across clients.

## Derived data

Links, full-text search, type membership from text, cards from text and field readings are all derived in the same transaction as the text that produces them. Each can be rebuilt from blocks.

## Open decisions

- Live references versus frozen quotations.
- How much change history to keep, and whether old assessments become immutable.
- Configurable task keywords beyond the five fixed states.
- Whether blank blocks persist or exist only in drafts.
- How Tessera and Bibliotheca exchange source identities.
