-- Remove Phase 1 schema in reverse dependency order.

DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS execution_runs;
DROP TABLE IF EXISTS task_sessions;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS task_dependencies;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS project_requirements;
DROP TABLE IF EXISTS projects;

DROP FUNCTION IF EXISTS set_updated_at();
