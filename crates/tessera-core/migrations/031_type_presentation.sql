CREATE TABLE type_presentation (
    type_id TEXT PRIMARY KEY REFERENCES blocks(id),
    plural TEXT,
    icon TEXT
);
