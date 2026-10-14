-- What a field counts as in creator readings. Built-in fields take theirs from the core's schema instead.
ALTER TABLE fields ADD COLUMN counts_as TEXT CHECK (counts_as IN ('creator','contributor','originator'));
