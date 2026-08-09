#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 -q -c '
CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT NOW()
);'

# Existing developer databases were initialized from the Phase 4 snapshot.
# Baseline only when the migration journal is new; fresh databases run all files.
if psql -qAt -c "SELECT to_regclass('public.projects') IS NOT NULL" | grep -q '^t$' \
  && [ "$(psql -qAt -c 'SELECT COUNT(*) FROM schema_migrations')" = "0" ]; then
  for version in 000001_phase1_init 000002_phase2_memory_and_evals 000003_phase3_autonomous_loops 000004_phase4_selective_autonomy; do
    psql -v ON_ERROR_STOP=1 -q -c "INSERT INTO schema_migrations (version) VALUES ('$version') ON CONFLICT DO NOTHING"
  done
fi

for file in /migrations/*.up.sql; do
  version=$(basename "$file" .up.sql)
  if [ "$(psql -qAt -c "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '$version')")" = "t" ]; then
    continue
  fi
  # One migration file is one transaction. A failed migration is never left
  # partially applied before its journal entry is written.
  psql -1 -v ON_ERROR_STOP=1 -f "$file"
  psql -v ON_ERROR_STOP=1 -q -c "INSERT INTO schema_migrations (version) VALUES ('$version')"
done
