CREATE TABLE note_states (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    resolved_at INTEGER,
    revisit_on TEXT,
    date_set_at INTEGER
) STRICT;

CREATE TABLE revisit_events (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES blocks(id),
    revisited_on TEXT NOT NULL,
    next_on TEXT,
    created_at INTEGER NOT NULL,
    change_seq INTEGER NOT NULL REFERENCES changes(seq),
    undone INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1))
) STRICT;
CREATE INDEX revisit_events_block ON revisit_events(block_id, created_at);

-- Existing question dates retain their last authored timestamp as the first anchor.
INSERT INTO note_states(block_id, date_set_at)
SELECT q.block_id, b.updated_at FROM questions q JOIN blocks b ON b.id = q.block_id
WHERE q.active = 1 AND json_extract(q.state, '$.review_on') IS NOT NULL;
