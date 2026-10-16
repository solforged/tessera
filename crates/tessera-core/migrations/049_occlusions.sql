CREATE TABLE occlusions (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    state TEXT NOT NULL
) STRICT;

-- Rebuild both ends of the card/event foreign key, preserving rowids and evidence.
CREATE TABLE card_units_occlusion (
    id TEXT PRIMARY KEY,
    source_block_id TEXT NOT NULL REFERENCES blocks(id),
    key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('forward', 'reverse', 'cloze', 'multiline', 'list', 'descriptor', 'occlusion')),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    schedule TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
    UNIQUE (source_block_id, key)
) STRICT;
INSERT INTO card_units_occlusion
    (rowid, id, source_block_id, key, kind, active, definition_revision,
     front, back, revision, schedule, created_at, updated_at, held)
    SELECT rowid, id, source_block_id, key, kind, active, definition_revision,
           front, back, revision, schedule, created_at, updated_at, held
    FROM card_units;

CREATE TABLE review_events_occlusion (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES card_units_occlusion(id),
    session_id TEXT REFERENCES review_sessions(id),
    kind TEXT NOT NULL CHECK (kind IN ('grade', 'reset')),
    grade TEXT CHECK (grade IN ('again', 'hard', 'good', 'easy')),
    shown_front TEXT NOT NULL,
    shown_back TEXT NOT NULL,
    definition_revision INTEGER NOT NULL,
    scheduler_version TEXT NOT NULL,
    before_state TEXT NOT NULL,
    after_state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    change_seq INTEGER NOT NULL REFERENCES changes(seq),
    event_order INTEGER NOT NULL DEFAULT 0,
    CHECK ((kind = 'grade' AND grade IS NOT NULL) OR (kind = 'reset' AND grade IS NULL))
) STRICT;
INSERT INTO review_events_occlusion
    (rowid, id, card_id, session_id, kind, grade, shown_front, shown_back,
     definition_revision, scheduler_version, before_state, after_state, created_at, change_seq, event_order)
    SELECT rowid, id, card_id, session_id, kind, grade, shown_front, shown_back,
           definition_revision, scheduler_version, before_state, after_state, created_at, change_seq, event_order
    FROM review_events;

CREATE TABLE review_undos_occlusion (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL UNIQUE REFERENCES review_events_occlusion(id),
    undone_at INTEGER NOT NULL CHECK (undone_at >= 0),
    change_seq INTEGER NOT NULL REFERENCES changes(seq)
) STRICT;
INSERT INTO review_undos_occlusion(rowid, id, review_id, undone_at, change_seq)
    SELECT rowid, id, review_id, undone_at, change_seq FROM review_undos;
DROP VIEW effective_review_events;
DROP TABLE review_undos;
DROP TABLE review_events;
DROP TABLE card_units;
ALTER TABLE card_units_occlusion RENAME TO card_units;
ALTER TABLE review_events_occlusion RENAME TO review_events;
ALTER TABLE review_undos_occlusion RENAME TO review_undos;
CREATE INDEX card_units_source ON card_units(source_block_id);
CREATE INDEX card_units_template ON card_units(key, source_block_id);
CREATE INDEX review_events_card ON review_events(card_id, created_at, id);
CREATE INDEX review_events_session ON review_events(session_id, created_at, id);
CREATE INDEX review_events_unordered ON review_events(change_seq) WHERE event_order = 0;
CREATE INDEX review_events_card_order ON review_events(card_id, change_seq, event_order, id);
CREATE INDEX review_events_session_order ON review_events(session_id, change_seq, event_order, id);
CREATE VIEW effective_review_events AS
    SELECT e.* FROM review_events e
    WHERE NOT EXISTS (SELECT 1 FROM review_undos u WHERE u.review_id = e.id);
