CREATE TABLE tasks (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    state TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    state TEXT NOT NULL
) STRICT;

CREATE TABLE task_occurrences (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES blocks(id),
    completed_on TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    after_state TEXT NOT NULL,
    reversed INTEGER NOT NULL DEFAULT 0 CHECK (reversed IN (0, 1)),
    created_at INTEGER NOT NULL,
    change_seq INTEGER NOT NULL REFERENCES changes(seq),
    reversed_seq INTEGER REFERENCES changes(seq)
) STRICT;
CREATE INDEX task_occurrences_block ON task_occurrences(block_id, created_at, id);
CREATE INDEX task_occurrences_completed ON task_occurrences(completed_on, block_id) WHERE reversed = 0;

CREATE TABLE work_sessions (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES blocks(id),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    ended_at INTEGER CHECK (ended_at >= started_at),
    note TEXT NOT NULL,
    reversed INTEGER NOT NULL DEFAULT 0 CHECK (reversed IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_seq INTEGER NOT NULL REFERENCES changes(seq),
    updated_seq INTEGER NOT NULL REFERENCES changes(seq)
) STRICT;
CREATE UNIQUE INDEX work_sessions_running ON work_sessions((1)) WHERE ended_at IS NULL AND reversed = 0;
CREATE INDEX work_sessions_block ON work_sessions(block_id, started_at, id);

CREATE TABLE card_units (
    id TEXT PRIMARY KEY,
    source_block_id TEXT NOT NULL REFERENCES blocks(id),
    key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('forward', 'reverse', 'cloze')),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    schedule TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source_block_id, key)
) STRICT;
CREATE INDEX card_units_source ON card_units(source_block_id);

CREATE TABLE decks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE task_views (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE review_sessions (
    id TEXT PRIMARY KEY,
    deck_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    state TEXT NOT NULL CHECK (state IN ('open', 'finished', 'abandoned')),
    revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;

CREATE TABLE review_events (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES card_units(id),
    session_id TEXT REFERENCES review_sessions(id),
    kind TEXT NOT NULL CHECK (kind IN ('grade', 'reset')),
    grade TEXT CHECK (grade IN ('again', 'hard', 'good', 'easy')),
    shown_front TEXT NOT NULL,
    shown_back TEXT NOT NULL,
    definition_revision INTEGER NOT NULL,
    scheduler_version INTEGER NOT NULL,
    before_state TEXT NOT NULL,
    after_state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    change_seq INTEGER NOT NULL REFERENCES changes(seq),
    CHECK ((kind = 'grade' AND grade IS NOT NULL) OR (kind = 'reset' AND grade IS NULL))
) STRICT;
CREATE INDEX review_events_card ON review_events(card_id, created_at, id);
CREATE INDEX review_events_session ON review_events(session_id, created_at, id);
