-- A replica not heard from for 30 days is retired: the hub stops keeping
-- patches for it. It can still push, and has to be cloned again to pull.
ALTER TABLE sync_replicas ADD COLUMN retired_at INTEGER;
