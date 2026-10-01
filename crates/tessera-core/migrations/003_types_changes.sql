-- Memberships are derived from text; live reads also check both endpoints.
CREATE TABLE memberships (
    block_id TEXT NOT NULL REFERENCES blocks(id),
    type_id TEXT NOT NULL REFERENCES blocks(id),
    PRIMARY KEY (block_id, type_id)
) STRICT;
CREATE INDEX memberships_type ON memberships(type_id, block_id);

-- Previous releases did not retain historical topology. New changes record
-- these pages at apply time rather than guessing from blocks' current location.
ALTER TABLE changes ADD COLUMN restructured_pages TEXT NOT NULL DEFAULT '[]';
