CREATE TABLE IF NOT EXISTS decision_cycles (
  cycle_id uuid PRIMARY KEY,
  mode varchar(8) NOT NULL DEFAULT 'paper' CHECK (mode = 'paper'),
  symbol varchar(10) NOT NULL,
  status varchar(32) NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS decision_contexts (
  decision_context_id uuid PRIMARY KEY,
  cycle_id uuid NOT NULL REFERENCES decision_cycles(cycle_id),
  context_version integer NOT NULL,
  content_hash varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decision_context_cycle_version_uq UNIQUE (cycle_id, context_version)
);

CREATE TABLE IF NOT EXISTS stage_runs (
  stage_run_id uuid PRIMARY KEY,
  cycle_id uuid NOT NULL REFERENCES decision_cycles(cycle_id),
  decision_context_id uuid NOT NULL REFERENCES decision_contexts(decision_context_id),
  stage varchar(32) NOT NULL,
  status varchar(24) NOT NULL,
  provider varchar(32),
  provider_request_id text,
  model text,
  input jsonb,
  output jsonb,
  failure_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_orders (
  order_id uuid PRIMARY KEY,
  cycle_id uuid NOT NULL REFERENCES decision_cycles(cycle_id),
  decision_context_id uuid NOT NULL REFERENCES decision_contexts(decision_context_id),
  stage_run_id uuid REFERENCES stage_runs(stage_run_id),
  mode varchar(8) NOT NULL DEFAULT 'paper' CHECK (mode = 'paper'),
  client_order_id varchar(128) NOT NULL,
  broker_order_id text,
  symbol varchar(10) NOT NULL,
  side varchar(8) NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity numeric(30, 12) NOT NULL CHECK (quantity > 0),
  limit_price numeric(30, 12) CHECK (limit_price IS NULL OR limit_price >= 0),
  status varchar(32) NOT NULL,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paper_orders_client_id_uq UNIQUE (client_order_id)
);

CREATE TABLE IF NOT EXISTS fills (
  fill_id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES paper_orders(order_id),
  cycle_id uuid NOT NULL REFERENCES decision_cycles(cycle_id),
  decision_context_id uuid NOT NULL REFERENCES decision_contexts(decision_context_id),
  stage_run_id uuid REFERENCES stage_runs(stage_run_id),
  mode varchar(8) NOT NULL DEFAULT 'paper' CHECK (mode = 'paper'),
  broker_fill_id text,
  quantity numeric(30, 12) NOT NULL CHECK (quantity > 0),
  price numeric(30, 12) NOT NULL CHECK (price >= 0),
  filled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS normalized_market_records (
  market_record_id uuid PRIMARY KEY,
  cycle_id uuid REFERENCES decision_cycles(cycle_id),
  decision_context_id uuid REFERENCES decision_contexts(decision_context_id),
  symbol varchar(10) NOT NULL,
  record_type varchar(32) NOT NULL,
  source varchar(32) NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_decisions (
  risk_decision_id uuid PRIMARY KEY,
  cycle_id uuid NOT NULL REFERENCES decision_cycles(cycle_id),
  decision_context_id uuid NOT NULL REFERENCES decision_contexts(decision_context_id),
  stage_run_id uuid REFERENCES stage_runs(stage_run_id),
  mode varchar(8) NOT NULL DEFAULT 'paper' CHECK (mode = 'paper'),
  outcome varchar(16) NOT NULL,
  rules jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS health_connection_samples (
  health_sample_id uuid PRIMARY KEY,
  component varchar(32) NOT NULL,
  status varchar(24) NOT NULL,
  detail text NOT NULL,
  sampled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kill_switch_state (
  singleton_id integer PRIMARY KEY CHECK (singleton_id = 1),
  enabled boolean NOT NULL,
  reason text,
  changed_at timestamptz NOT NULL,
  changed_by text NOT NULL
);

CREATE TABLE IF NOT EXISTS configuration_snapshots (
  config_snapshot_id uuid PRIMARY KEY,
  version integer NOT NULL,
  digest varchar(64) NOT NULL,
  mode varchar(8) NOT NULL DEFAULT 'paper' CHECK (mode = 'paper'),
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT configuration_snapshot_version_uq UNIQUE (version)
);

CREATE TABLE IF NOT EXISTS cycle_outcomes (
  cycle_outcome_id uuid PRIMARY KEY,
  cycle_id uuid NOT NULL REFERENCES decision_cycles(cycle_id),
  decision_context_id uuid NOT NULL REFERENCES decision_contexts(decision_context_id),
  outcome_version integer NOT NULL,
  label text,
  reference_price numeric(30, 12),
  horizon_seconds integer,
  observed_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cycle_outcomes_cycle_version_uq UNIQUE (cycle_id, outcome_version)
);

CREATE INDEX IF NOT EXISTS decision_contexts_cycle_idx ON decision_contexts(cycle_id);
CREATE INDEX IF NOT EXISTS stage_runs_cycle_idx ON stage_runs(cycle_id);
CREATE INDEX IF NOT EXISTS paper_orders_cycle_idx ON paper_orders(cycle_id);
CREATE INDEX IF NOT EXISTS fills_cycle_idx ON fills(cycle_id);
CREATE INDEX IF NOT EXISTS market_records_symbol_time_idx ON normalized_market_records(symbol, observed_at);
CREATE INDEX IF NOT EXISTS risk_decisions_cycle_idx ON risk_decisions(cycle_id);

INSERT INTO kill_switch_state(singleton_id, enabled, reason, changed_at, changed_by)
VALUES (1, false, NULL, now(), 'system') ON CONFLICT (singleton_id) DO NOTHING;
