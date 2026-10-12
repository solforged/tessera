CREATE TABLE card_templates (
    id TEXT PRIMARY KEY,
    type_id TEXT NOT NULL REFERENCES blocks(id),
    name TEXT NOT NULL,
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    position INTEGER NOT NULL,
    applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
    new_per_day INTEGER NOT NULL CHECK (new_per_day BETWEEN 1 AND 9999),
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX card_templates_type ON card_templates(type_id, position);
CREATE INDEX card_units_template ON card_units(key, source_block_id);
