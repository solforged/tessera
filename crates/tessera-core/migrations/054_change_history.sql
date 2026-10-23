-- History for every local change: the agent-only table becomes change_history, where `undo`
-- may be NULL for entries without a safe inverse and `undoes_seq` links an undo to its change.
-- Tests rewind user_version on a current schema and replay later migrations, so this must also
-- succeed when change_history already exists and agent_changes is gone.
CREATE TABLE IF NOT EXISTS agent_changes (
    seq INTEGER PRIMARY KEY REFERENCES changes(seq),
    summary TEXT NOT NULL,
    page_id TEXT,
    undo TEXT NOT NULL,
    undone_seq INTEGER REFERENCES changes(seq)
) STRICT;
CREATE TABLE IF NOT EXISTS change_history (
    seq INTEGER PRIMARY KEY REFERENCES changes(seq),
    summary TEXT NOT NULL,
    page_id TEXT,
    undo TEXT,
    undone_seq INTEGER REFERENCES changes(seq),
    undoes_seq INTEGER REFERENCES changes(seq)
) STRICT;
INSERT OR IGNORE INTO change_history(seq, summary, page_id, undo, undone_seq)
SELECT seq, summary, page_id, undo, undone_seq FROM agent_changes;
DROP TABLE agent_changes;
-- Older undo batches predate the explicit link, but their originals name them.
INSERT OR IGNORE INTO change_history(seq, summary, undoes_seq)
SELECT undone_seq, 'Undid change ' || seq, seq FROM change_history
WHERE undone_seq IS NOT NULL;
