ALTER TABLE decision_contexts
  ADD COLUMN mode varchar(8) NOT NULL DEFAULT 'paper' CHECK (mode = 'paper');

ALTER TABLE stage_runs
  ADD COLUMN mode varchar(8) NOT NULL DEFAULT 'paper' CHECK (mode = 'paper');
