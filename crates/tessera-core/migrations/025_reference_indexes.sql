-- Every commit asks whether anything still refers to each provisional page.
-- Each reference it checks needs an index, or the check scans the table once
-- per page and a large library makes every commit slow.
CREATE INDEX field_values_entry ON field_values(entry_id);
CREATE INDEX field_values_value ON field_values(value_id);
CREATE INDEX type_fields_field ON type_fields(field_id);
CREATE INDEX questions_accepted ON questions(json_extract(state, '$.accepted'));
CREATE INDEX ingest_jobs_target ON ingest_jobs(target_source) WHERE target_source IS NOT NULL;
