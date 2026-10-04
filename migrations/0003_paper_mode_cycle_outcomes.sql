ALTER TABLE cycle_outcomes
  ADD COLUMN mode varchar(8) NOT NULL DEFAULT 'paper' CHECK (mode = 'paper');
