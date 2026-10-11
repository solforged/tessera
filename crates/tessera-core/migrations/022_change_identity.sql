-- This device. Local to the directory: a notebook cloned onto another device
-- gets a new device ID; a backup restored on the same device keeps it.
CREATE TABLE replica (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    device_id TEXT NOT NULL
) STRICT;

-- A change's global identity and the device that made it. `seq` stays the
-- local order. Changes committed before this migration have neither.
ALTER TABLE changes ADD COLUMN change_id TEXT;
ALTER TABLE changes ADD COLUMN origin TEXT;
CREATE UNIQUE INDEX changes_change_id ON changes(change_id) WHERE change_id IS NOT NULL;
