ALTER TABLE card_templates ADD COLUMN hint TEXT;
ALTER TABLE card_templates ADD COLUMN details TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(details) AND json_type(details) = 'array');
