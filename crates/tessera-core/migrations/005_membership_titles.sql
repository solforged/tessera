-- Memberships are derived, so rebuild them from text after this migration.
-- Keep the authored title key even when no live page currently resolves it.
DROP TABLE memberships;
CREATE TABLE memberships (
    block_id TEXT NOT NULL REFERENCES blocks(id),
    title_key TEXT NOT NULL,
    type_id TEXT REFERENCES blocks(id),
    PRIMARY KEY (block_id, title_key)
) STRICT;
CREATE INDEX memberships_type ON memberships(type_id, block_id);
CREATE INDEX memberships_title ON memberships(title_key, block_id);
