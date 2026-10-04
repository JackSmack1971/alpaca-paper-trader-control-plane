ALTER TABLE local_runtime_snapshots
  ADD CONSTRAINT local_runtime_snapshot_size_check
  CHECK (octet_length(snapshot::text) <= 262144);
