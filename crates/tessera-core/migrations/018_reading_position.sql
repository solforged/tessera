-- Progress is the reading position alone; the coverage ranges are no longer kept.
ALTER TABLE reading_positions DROP COLUMN covered;
