-- Editor cursors are local arrival order, not the replicated change sequence.
CREATE TABLE editor_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    committed TEXT NOT NULL,
    restructured_pages TEXT NOT NULL,
    views TEXT NOT NULL
);
INSERT INTO editor_events(seq, actor, reason, created_at, committed, restructured_pages, views)
SELECT seq, actor, reason, created_at, committed, restructured_pages, views FROM changes ORDER BY seq;
