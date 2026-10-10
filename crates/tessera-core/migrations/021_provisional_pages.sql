-- Only type pages created after this migration are eligible for cleanup.
CREATE TABLE provisional_pages (
    id TEXT PRIMARY KEY REFERENCES blocks(id)
) STRICT;
