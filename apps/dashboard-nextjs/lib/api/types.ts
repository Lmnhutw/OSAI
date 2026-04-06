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

export interface ApprovalInput {
  requested_by: string;
  decision_note?: string;
}

export interface BatchTaskApproveInput {
  task_ids: string[];
}
