CREATE TABLE highlight_surfacings (
    citation_id TEXT NOT NULL REFERENCES citations(id), date TEXT NOT NULL,
    shown_at INTEGER NOT NULL, action TEXT CHECK (action IN ('kept','opened','muted')),
    acted_at INTEGER, PRIMARY KEY (citation_id, date)
);
CREATE INDEX surfacings_by_date ON highlight_surfacings(date);
ALTER TABLE citations ADD COLUMN resurface_muted_at INTEGER;