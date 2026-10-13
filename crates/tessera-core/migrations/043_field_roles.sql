ALTER TABLE fields ADD COLUMN role TEXT NOT NULL DEFAULT 'attribute' CHECK (role IN ('standfirst','attribute','prose','citation'));
INSERT INTO fields(block_id, kind, role)
SELECT d.id, 'text', 'standfirst'
FROM blocks d JOIN blocks p ON p.id = d.parent_id
WHERE p.kind = 'page' AND p.title_key = 'fields' AND p.deletion_id IS NULL
  AND lower(trim(d.text)) IN ('gist', 'gloss')
ON CONFLICT(block_id) DO UPDATE SET role = excluded.role;
