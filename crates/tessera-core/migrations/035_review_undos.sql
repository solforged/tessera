-- SQLite changesets do not carry rowid for a TEXT primary key. Persist the
-- evidence order so equal/backdated timestamps and reset+grade stay ordered.
ALTER TABLE review_events ADD COLUMN event_order INTEGER NOT NULL DEFAULT 0;
UPDATE review_events SET event_order = rowid;
CREATE INDEX review_events_order ON review_events(event_order);
CREATE INDEX review_events_card_order ON review_events(card_id, event_order, id);
CREATE INDEX review_events_session_order ON review_events(session_id, event_order, id);

-- Corrections are append-only commands, just like their original review evidence.
-- Applied replication also carries inverse patches during optimistic rollback.
CREATE TABLE review_undos (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL UNIQUE REFERENCES review_events(id),
    undone_at INTEGER NOT NULL CHECK (undone_at >= 0),
    change_seq INTEGER NOT NULL REFERENCES changes(seq)
) STRICT;

CREATE VIEW effective_review_events AS
    SELECT e.* FROM review_events e
    WHERE NOT EXISTS (SELECT 1 FROM review_undos u WHERE u.review_id = e.id);
