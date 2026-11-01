-- An agent request sent under an idempotency key keeps that key, a hash of the request and its
-- receipt with its history entry, so sending the request again returns the receipt instead of
-- writing twice. Tests replay later migrations on a current schema, and SQLite cannot add a column
-- only when it is missing, so the migration runs only while the key column is absent.
ALTER TABLE change_history ADD COLUMN idempotency_key TEXT;
ALTER TABLE change_history ADD COLUMN request_hash TEXT;
ALTER TABLE change_history ADD COLUMN receipt TEXT;
CREATE UNIQUE INDEX change_history_idempotency_key ON change_history(idempotency_key)
    WHERE idempotency_key IS NOT NULL;
