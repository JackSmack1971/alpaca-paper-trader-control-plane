CREATE TABLE local_runtime_snapshots (
  scenario_key text PRIMARY KEY CHECK (scenario_key = 'checked-in-local-fixtures'),
  snapshot_version integer NOT NULL CHECK (snapshot_version = 1),
  revision integer NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
