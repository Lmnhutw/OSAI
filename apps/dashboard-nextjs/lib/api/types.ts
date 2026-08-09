export type ResourceState = "ready" | "missing" | "offline" | "not_found" | "error";

export interface ApiResource<T> {
  data: T;
  state: ResourceState;
  path: string;
  status?: number;
  message?: string;
}

export interface HealthStatus {
  status: string;
}

export interface ModelProfileStatus {
  profile: string;
  configured: boolean;
  provider: string | null;
  model: string | null;
  base_url: string | null;
  error: string | null;
}

export interface AgentRun {
  id: string;
  workflow_run_id: string | null;
  project_id: string;
  plan_id: string | null;
  task_id: string | null;
  agent_key: string;
  model_profile: string;
  status: string;
  correlation_id: string;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OperatorQueueItem {
  item_type: "plan_approval" | "task_attention";
  status: string;
  title: string;
  project_id: string;
  plan_id: string | null;
  task_id: string | null;
  approval_id: string | null;
  requested_by: string | null;
  created_at: string;
}

export interface OperatorQueue {
  items: OperatorQueueItem[];
  total: number;
  limit: number;
}

export interface JiraSync {
  id: string;
  task_id: string;
  project_id: string;
  sync_status: string;
  external_issue_key: string | null;
  external_issue_url: string | null;
  error_message: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  synchronized_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutonomyOverrideInput {
  reason: string;
  force_autonomy_mode?: "auto_execute" | "review_required" | "blocked";
  force_review?: boolean;
  disable_retries?: boolean;
  sensitive_modules?: string[];
}

export interface SearchItem {
  resource_type: "project" | "plan" | "task";
  resource_id: string;
  project_id: string | null;
  plan_id: string | null;
  title: string;
  subtitle: string | null;
  status: string | null;
}

export interface SearchResponse {
  query: string;
  items: SearchItem[];
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectRequirement {
  id: string;
  project_id: string;
  position: number;
  requirement_text: string;
  created_at: string;
  updated_at: string;
}

export interface Plan {
  id: string;
  project_id: string;
  version: number;
  title: string;
  summary: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  plan_id: string;
  position: number;
  task_type: string;
  title: string;
  instructions: string;
  status: string;
  input_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TaskDependency {
  id: string;
  task_id: string;
  depends_on_task_id: string;
  dependency_type: string;
  created_at: string;
}

export interface TaskRelationship {
  id: string;
  parent_task_id: string;
  child_task_id: string;
  relationship_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TaskLoopState {
  id: string;
  task_id: string;
  status: string;
  current_action: string | null;
  retry_count: number;
  consecutive_failures: number;
  chain_depth: number;
  follow_up_count: number;
  last_result_status: string | null;
  last_bug_category: string | null;
  last_failure_pattern: string | null;
  last_task_session_id: string | null;
  last_run_id: string | null;
  loop_started_at: string;
  last_transition_at: string;
  timeout_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskLoopHistoryEntry {
  id: string;
  task_loop_id: string | null;
  task_id: string;
  task_session_id: string | null;
  execution_run_id: string | null;
  action: string;
  task_status: string | null;
  result_status: string | null;
  bug_category: string | null;
  failure_pattern_key: string | null;
  retry_count: number;
  chain_depth: number;
  summary: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface Approval {
  id: string;
  plan_id: string;
  requested_by: string;
  approver: string | null;
  status: string;
  decision_note: string | null;
  requested_at: string;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskSession {
  id: string;
  task_id: string;
  status: string;
  artifact_path: string | null;
  metadata: Record<string, unknown>;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionRun {
  id: string;
  task_session_id: string;
  attempt_no: number;
  status: string;
  worker_name: string | null;
  artifact_path: string | null;
  input_payload: Record<string, unknown>;
  output_payload: Record<string, unknown>;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRecord {
  id: string;
  project_id: string | null;
  plan_id: string | null;
  task_id: string | null;
  task_session_id: string | null;
  execution_run_id: string | null;
  event_source: string;
  event_type: string;
  artifact_path: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

export interface DependencyStatus {
  task_id: string;
  title: string;
  status: string;
  dependency_type: string;
}

export interface PolicyDecision {
  allow_auto_execute: boolean;
  require_review: boolean;
  require_qa: boolean;
  require_approval: boolean;
  block: boolean;
  escalate: boolean;
  retry_allowed: boolean;
  manual_break_required: boolean;
  max_retry: number;
  max_chain_depth: number;
  loop_timeout_seconds: number;
  risk_threshold: string;
  reason_codes: string[];
  evidence: Record<string, unknown>;
}

export interface DispatchEvaluation {
  task_id: string;
  status: string;
  ready_for_execution: boolean;
  risk_level: string;
  missing_context: string[];
  risk_flags: string[];
  acceptance_criteria: string[];
  constraints: string[];
  dependencies: DependencyStatus[];
  execution_payload: Record<string, unknown>;
  policy_decision: PolicyDecision;
  evaluated_at: string;
}

export interface ReviewerDecision {
  status: string;
  matched_acceptance_criteria: string[];
  unmet_acceptance_criteria: string[];
  scope_deviation: boolean;
  risky_changes: string[];
  notes: string[];
}

export interface ValidationCheck {
  acceptance_criterion: string;
  status: string;
  evidence: string | null;
}

export interface QADecision {
  status: string;
  validation_checks: ValidationCheck[];
  missing_checks: string[];
  potential_regressions: string[];
  notes: string[];
}

export interface FailurePattern {
  pattern_key: string;
  category: string;
  occurrence_count: number;
  recurring: boolean;
  evidence: string[];
  memory_hits: string[];
}

export interface BugTriage {
  category: string;
  pattern_key: string | null;
  summary: string;
  recommended_action: string;
  severity: string;
  evidence: string[];
}

export interface LoopDecision {
  task_id: string;
  run_id: string | null;
  next_action: string;
  status: string;
  reasons: string[];
  requires_human: boolean;
  retry_count: number;
  chain_depth: number;
  follow_up_task_id: string | null;
  chained_task_ids: string[];
  bug_triage: BugTriage | null;
  failure_patterns: FailurePattern[];
  policy_decision: PolicyDecision;
  loop_state: TaskLoopState;
  decided_at: string;
}

export interface ResultEvaluation {
  run_id: string;
  task_id: string;
  task_session_id: string;
  status: string;
  risk_flags: string[];
  follow_up_actions: string[];
  reviewer_decision: ReviewerDecision;
  qa_decision: QADecision;
  policy_decision: PolicyDecision;
  loop_decision: LoopDecision | null;
  evaluated_at: string;
}

export interface MemoryEvidenceRef {
  source_type: string;
  ref_id: string | null;
  artifact_path: string | null;
  note: string | null;
}

export interface MemoryEntry {
  scope: string;
  source_type: string;
  subject: string;
  summary: string;
  evidence_refs: MemoryEvidenceRef[];
  constraints: string[];
  decision_impact: string;
  confidence: number;
  dedupe_key: string;
  updated_at: string | null;
}

export interface TaskMemory {
  task_id: string;
  project_id: string;
  summary: string | null;
  entries: MemoryEntry[];
  generated_at: string | null;
  source_event_id: string | null;
}

export interface ProjectMemory {
  project_id: string;
  summary: string | null;
  entries: MemoryEntry[];
  generated_at: string | null;
  source_event_id: string | null;
}

export interface TaskHistoryEvent {
  timestamp: string;
  source: string;
  entry_type: string;
  summary: string;
  task_status: string | null;
  task_session_id: string | null;
  execution_run_id: string | null;
  related_task_id: string | null;
  payload: Record<string, unknown>;
}

export interface TaskHistory {
  task_id: string;
  loop_state: TaskLoopState | null;
  relationships: TaskRelationship[];
  loop_history: TaskLoopHistoryEntry[];
  entries: TaskHistoryEvent[];
}

export interface ApprovalInput {
  requested_by: string;
  decision_note?: string;
}

export interface ApprovalDecisionInput {
  decision: "approved" | "rejected" | "changes_requested";
  decision_note?: string;
  expected_plan_updated_at?: string;
  idempotency_key: string;
}

export interface BatchTaskApproveInput {
  task_ids: string[];
}
