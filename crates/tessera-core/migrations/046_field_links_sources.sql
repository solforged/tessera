-- A relation that links to sources, a capability rather than a type page, beside any Links to types.
ALTER TABLE fields ADD COLUMN links_sources INTEGER NOT NULL DEFAULT 0 CHECK (links_sources IN (0, 1));
