CREATE TABLE images (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    sha256 TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0)
) STRICT;
