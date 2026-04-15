# Database migrations

This directory is laid out for plain SQL migrations without assuming a specific ORM or framework.

- `000001_phase1_init.up.sql` bootstraps the Phase 1 schema.
- `000001_phase1_init.down.sql` removes the Phase 1 schema in reverse dependency order.
- `000002_phase2_memory_and_evals.up.sql` adds curated memory, evaluation tracking, and richer execution metadata.
- `000002_phase2_memory_and_evals.down.sql` removes the Phase 2 additions.
- `000003_phase3_autonomous_loops.up.sql` adds loop history, task chaining, retry timestamps, and recurring failure patterns.
- `000003_phase3_autonomous_loops.down.sql` removes the Phase 3 additions.
- `000004_phase4_selective_autonomy.up.sql` adds selective-autonomy decisions, overrides, task classifications, execution contracts, and richer autonomy audit fields.
- `000004_phase4_selective_autonomy.down.sql` removes the Phase 4 additions.
- `../schema/schema.sql` is the full schema snapshot and should stay aligned with the latest migration state.

The file naming pattern is compatible with common raw-SQL migration runners, including tools that expect `*.up.sql` and `*.down.sql` pairs.

The `pgcrypto` extension is created by the `up` migration because the schema uses `gen_random_uuid()` for primary keys. The `down` migration leaves the extension installed to avoid dropping shared database capabilities outside this schema's scope.
