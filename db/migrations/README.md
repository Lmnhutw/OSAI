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
- `000005_ai_runtime.up.sql` adds the three-profile model runtime, agent definitions, versioned prompts, workflow runs, agent runs, and audited model calls.
- `000005_ai_runtime.down.sql` removes the AI runtime additions in reverse dependency order.
- `000006_canonical_orm_reconciliation.up.sql` maps legacy ORM concepts onto `task_links`, `task_history`, and `policy_overrides` without changing public API names.
- `000006_canonical_orm_reconciliation.down.sql` removes the compatibility columns and indexes.
- `000007_actor_aware_approvals.up.sql` adds actor-aware, version-checked, idempotent plan approval requests and decisions.
- `000007_actor_aware_approvals.down.sql` removes the approval command metadata and uniqueness guarantees.
- `000008_jira_issue_sync.up.sql` adds durable, idempotent mapping between OSAI tasks and Jira issues.
- `000008_jira_issue_sync.down.sql` removes the Jira sync mapping.
- `migrate.sh` applies `*.up.sql` files once and records them in `schema_migrations`; it baselines existing Phase 4 developer databases before applying later migrations.
- `../schema/schema.sql` is the full schema snapshot and should stay aligned with the latest migration state.

The file naming pattern is compatible with common raw-SQL migration runners, including tools that expect `*.up.sql` and `*.down.sql` pairs.

The `pgcrypto` extension is created by the `up` migration because the schema uses `gen_random_uuid()` for primary keys. The `down` migration leaves the extension installed to avoid dropping shared database capabilities outside this schema's scope.
