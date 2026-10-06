ALTER TABLE citations ADD COLUMN color TEXT CHECK (color IN ('yellow','green','blue','red','purple'));
