-- Discovery walks only hidden subtrees, starting from archived live blocks.
CREATE INDEX blocks_live_archived ON blocks(id)
    WHERE archived = 1 AND deletion_id IS NULL;
