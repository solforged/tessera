-- Editor cursors are local arrival order, not the replicated change sequence.
CREATE TABLE editor_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id TEXT,
    actor TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    committed TEXT NOT NULL,
    restructured_pages TEXT NOT NULL,
    views TEXT NOT NULL
);
CREATE INDEX editor_events_change ON editor_events(change_id, seq);
INSERT INTO editor_events(seq, change_id, actor, reason, created_at, committed, restructured_pages, views)
SELECT seq, change_id, actor, reason, created_at, committed, restructured_pages, views FROM changes ORDER BY seq;
