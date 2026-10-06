ALTER TABLE citations ADD COLUMN triage TEXT CHECK (triage IN ('processed','unprocessed'));
