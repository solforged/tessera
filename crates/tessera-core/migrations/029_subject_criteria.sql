CREATE TABLE subject_criteria (
    subject_id TEXT NOT NULL REFERENCES blocks(id),
    field_id TEXT NOT NULL REFERENCES blocks(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (subject_id, field_id)
) STRICT;
CREATE INDEX subject_criteria_position ON subject_criteria(subject_id, position);
