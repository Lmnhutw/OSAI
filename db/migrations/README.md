# Database migrations

This directory is laid out for plain SQL migrations without assuming a specific ORM or framework.

- `000001_phase1_init.up.sql` bootstraps the Phase 1 schema.
- `000001_phase1_init.down.sql` removes the Phase 1 schema in reverse dependency order.
- `../schema/schema.sql` is the full schema snapshot and should stay aligned with the latest migration state.

The file naming pattern is compatible with common raw-SQL migration runners, including tools that expect `*.up.sql` and `*.down.sql` pairs.

The `pgcrypto` extension is created by the `up` migration because the schema uses `gen_random_uuid()` for primary keys. The `down` migration leaves the extension installed to avoid dropping shared database capabilities outside this schema's scope.
