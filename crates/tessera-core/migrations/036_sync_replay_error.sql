-- Why the latest replay of this outbox row failed. NULL while the change is
-- applied here or has not been replayed since the last integrate. Local only:
-- a push the hub refuses is a replicated rejected conflict, not this column.
ALTER TABLE sync_pending ADD COLUMN replay_error TEXT;
