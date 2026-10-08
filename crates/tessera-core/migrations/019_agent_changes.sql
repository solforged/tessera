-- Changes made through the agent write path, with what it takes to undo them.
-- `undo` is JSON: inverse operations plus the blocks and pages the change created.
CREATE TABLE agent_changes (
    seq INTEGER PRIMARY KEY REFERENCES changes(seq),
    summary TEXT NOT NULL,
    page_id TEXT,
    undo TEXT NOT NULL,
    undone_seq INTEGER REFERENCES changes(seq)
) STRICT;
