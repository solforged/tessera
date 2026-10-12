-- Local rowids are not replicated. Rust recovers each event's ordinal within
-- changes.operations; change_seq supplies the replicated order between batches.
-- Retained older patches omit this column and are repaired before sync commits.
ALTER TABLE review_events ADD COLUMN event_order INTEGER NOT NULL DEFAULT 0;
CREATE INDEX review_events_unordered ON review_events(change_seq) WHERE event_order = 0;
CREATE INDEX review_events_card_order ON review_events(card_id, change_seq, event_order, id);
CREATE INDEX review_events_session_order ON review_events(session_id, change_seq, event_order, id);

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
