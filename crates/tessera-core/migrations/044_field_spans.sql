-- Preserve presentation while widening the kind constraint.
CREATE TABLE fields_new (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id),
    kind TEXT NOT NULL CHECK (kind IN ('text','number','date','span','checkbox','choice','instance','url','identifier')),
    hide TEXT NOT NULL DEFAULT 'never' CHECK (hide IN ('never','when_empty','always')),
    role TEXT NOT NULL DEFAULT 'attribute' CHECK (role IN ('standfirst','attribute','prose','citation'))
) STRICT;
INSERT INTO fields_new SELECT block_id, kind, hide, role FROM fields;
DROP TABLE fields;
ALTER TABLE fields_new RENAME TO fields;
