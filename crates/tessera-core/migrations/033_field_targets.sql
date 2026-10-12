CREATE TABLE field_targets (
    field_id TEXT NOT NULL REFERENCES blocks(id),
    type_id TEXT NOT NULL REFERENCES blocks(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (field_id, type_id)
);
CREATE INDEX field_targets_type ON field_targets(type_id);
