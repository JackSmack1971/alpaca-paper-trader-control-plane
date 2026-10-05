ALTER TABLE stage_runs
  ADD COLUMN stage_version varchar(64),
  ADD COLUMN invocation_id uuid,
  ADD COLUMN attempt_number integer,
  ADD COLUMN requested_model text,
  ADD COLUMN resolved_model text,
  ADD COLUMN resolved_provider text,
  ADD COLUMN provider_system_fingerprint text,
  ADD COLUMN normalized_input_ref varchar(80),
  ADD COLUMN latency_ms integer,
  ADD COLUMN prompt_tokens integer,
  ADD COLUMN completion_tokens integer,
  ADD COLUMN reported_cost numeric(30, 12),
  ADD COLUMN response_evidence jsonb;

UPDATE stage_runs
SET stage_version = 'legacy',
    invocation_id = stage_run_id,
    attempt_number = 1,
    requested_model = COALESCE(model, 'unknown'),
    response_evidence = '{}'::jsonb;

ALTER TABLE stage_runs
  ALTER COLUMN stage_version SET NOT NULL,
  ALTER COLUMN invocation_id SET NOT NULL,
  ALTER COLUMN attempt_number SET NOT NULL,
  ALTER COLUMN requested_model SET NOT NULL,
  ALTER COLUMN response_evidence SET DEFAULT '{}'::jsonb,
  ALTER COLUMN response_evidence SET NOT NULL,
  ADD CONSTRAINT stage_runs_attempt_number_check CHECK (attempt_number > 0),
  ADD CONSTRAINT stage_runs_latency_check CHECK (latency_ms IS NULL OR latency_ms >= 0),
  ADD CONSTRAINT stage_runs_prompt_tokens_check CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  ADD CONSTRAINT stage_runs_completion_tokens_check CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  ADD CONSTRAINT stage_runs_reported_cost_check CHECK (reported_cost IS NULL OR reported_cost >= 0);

CREATE UNIQUE INDEX stage_runs_invocation_attempt_uq ON stage_runs(invocation_id, attempt_number);
