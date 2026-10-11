-- Reading positions and highlight surfacings are written outside the change
-- log and sync as last-writer-wins rows. `hlc` orders writes across devices
-- (a hybrid logical clock in milliseconds), `device` breaks ties, and
-- `sync_seq` is this notebook's own order of arrival, which replicas pull by.
-- A surfacing's clock is that of its last action, 0 before any.
ALTER TABLE reading_positions ADD COLUMN hlc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reading_positions ADD COLUMN device TEXT NOT NULL DEFAULT '';
ALTER TABLE reading_positions ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE highlight_surfacings ADD COLUMN hlc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE highlight_surfacings ADD COLUMN device TEXT NOT NULL DEFAULT '';
ALTER TABLE highlight_surfacings ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX reading_positions_sync ON reading_positions(sync_seq);
CREATE INDEX highlight_surfacings_sync ON highlight_surfacings(sync_seq);

-- The clock and the arrival counter behind those columns.
ALTER TABLE replica ADD COLUMN clock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE replica ADD COLUMN unlogged_seq INTEGER NOT NULL DEFAULT 0;

-- Replica side: the hub's arrival order pulled so far, and this replica's own
-- arrival order pushed so far.
ALTER TABLE sync_hub ADD COLUMN unlogged_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_hub ADD COLUMN unlogged_pushed INTEGER NOT NULL DEFAULT 0;

-- Replica side: sources whose original files and images this device keeps
-- without waiting for them to be opened.
CREATE TABLE sync_pins (
    source_id TEXT PRIMARY KEY,
    pinned_at INTEGER NOT NULL
) STRICT;
