ALTER TABLE fields ADD COLUMN hide TEXT NOT NULL DEFAULT 'never' CHECK (hide IN ('never','when_empty','always'));
