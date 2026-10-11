-- Hub side. Devices paired with a one-time code. Each holds a random key and
-- presents it on every request to the sync listener; the hub keeps only the
-- key's SHA-256 (hex). Forgetting a device deletes its row.
CREATE TABLE sync_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    paired_at INTEGER NOT NULL
) STRICT;

-- Hub side. The paired device that cloned each replica. A device that clones
-- again gets a new replica row with the same device.
ALTER TABLE sync_replicas ADD COLUMN paired_device TEXT;

-- Replica side. The key this device presents to the hub, the names shown in
-- the sync sheet, and when the last sync finished.
ALTER TABLE sync_hub ADD COLUMN key TEXT;
ALTER TABLE sync_hub ADD COLUMN hub_name TEXT;
ALTER TABLE sync_hub ADD COLUMN device_name TEXT;
ALTER TABLE sync_hub ADD COLUMN synced_at INTEGER;

-- Replicated. When a kept copy was made an ordinary block (Keep both); NULL
-- while it is still shown as a copy.
ALTER TABLE sync_conflicts ADD COLUMN settled_at INTEGER;
