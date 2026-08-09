import type {
  DispatchEvaluation,
  LoopDecision,
  PolicyDecision,
  QADecision,
  ResultEvaluation,
  ReviewerDecision,
  Task,
  TaskHistory,
  TaskMemory
} from "@/lib/api/types";
import { sentenceCase } from "@/lib/format";
import { deriveRiskLevel } from "@/lib/intelligence";

type UnknownRecord = Record<string, unknown>;

const productionTerms = [
  "production",
  "deploy",
  "release",
  "schema",
  "migration",
  "database",
  "billing",
  "payment"
];

const securityTerms = [
  "auth",
  "permission",
  "secret",
  "credential",
  "security",
  "token",
  "policy"
];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => Boolean(value && value.trim()))
        .map((value) => value.trim())
    )
  );
}

function flattenStrings(value: unknown): string[] {
  if (value == null) {
    return [];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenStrings(item));
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap((item) => flattenStrings(item));
  }

  return [];
}

function latestTaskEntry(history: TaskHistory, entryType: string) {
  return (
    [...history.entries]
      .filter((entry) => entry.entry_type === entryType)
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0] || null
  );
}

function latestTaskEntryPayload<T>(history: TaskHistory, entryType: string) {
  const entry = latestTaskEntry(history, entryType);

  if (!entry || !isRecord(entry.payload)) {
    return null;
  }

  return entry.payload as T;
}

function latestLoopHistory(history: TaskHistory) {
  return (
    [...history.loop_history].sort((left, right) => right.created_at.localeCompare(left.created_at))[0] ||
    null
  );
}

function defaultPolicyDecision(): PolicyDecision {
  return {
    allow_auto_execute: false,
    require_review: false,
    require_qa: false,
    require_approval: false,
    block: false,
    escalate: false,
    retry_allowed: false,
    manual_break_required: false,
    max_retry: 0,
    max_chain_depth: 0,
    loop_timeout_seconds: 0,
    risk_threshold: "unknown",
    reason_codes: [],
    evidence: {}
  };
}

function pickLoopDecision(history: TaskHistory, resultEvaluation: ResultEvaluation | null) {
  if (resultEvaluation?.loop_decision) {
    return resultEvaluation.loop_decision;
  }

  const entry = latestTaskEntry(history, "loop.decision_recorded");
  if (!entry || !isRecord(entry.payload)) {
    return null;
  }

  if (isRecord(entry.payload.loop_decision)) {
    return entry.payload.loop_decision as unknown as LoopDecision;
  }

  return entry.payload as unknown as LoopDecision;
}

function pickReviewerDecision(history: TaskHistory, resultEvaluation: ResultEvaluation | null) {
  if (resultEvaluation?.reviewer_decision) {
    return resultEvaluation.reviewer_decision;
  }

  return latestTaskEntryPayload<ReviewerDecision>(history, "reviewer.decision_recorded");
}

function pickQADecision(history: TaskHistory, resultEvaluation: ResultEvaluation | null) {
  if (resultEvaluation?.qa_decision) {
    return resultEvaluation.qa_decision;
  }

  return latestTaskEntryPayload<QADecision>(history, "qa.decision_recorded");
}

function computeExpiration(evaluatedAt: string | null, timeoutSeconds: number) {
  if (!evaluatedAt || timeoutSeconds <= 0) {
    return null;
  }

  const date = new Date(evaluatedAt);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Date(date.getTime() + timeoutSeconds * 1000).toISOString();
}

export interface AutonomyReference {
  id: string;
  label: string;
  detail: string;
  href: string;
}

export interface ExecutionContractSummary {
  executionMode: string;
  allowedActions: string[];
  retryLimit: number;
  approvalStatus: string;
  expirationAt: string | null;
}

export interface DerivedAutonomySnapshot {
  taskId: string;
  title: string;
  mode: "auto_execute" | "review_required" | "approval_required" | "blocked" | "manual";
  confidenceScore: number;
  confidenceBand: "high" | "medium" | "low";
  riskLevel: string;
  approvalRequired: boolean;
  reviewRequired: boolean;
  qaRequired: boolean;
  blockedByPolicy: boolean;
  autoExecutable: boolean;
  autoExecuted: boolean;
  escalatedToHuman: boolean;
  sensitiveScopeFlags: string[];
  allowedActions: string[];
  policyReasonCodes: string[];
  decisionSummary: string;
  contributingFactors: string[];
  evidence: string[];
  historyRefs: AutonomyReference[];
  memoryRefs: AutonomyReference[];
  contract: ExecutionContractSummary;
  evaluatedAt: string | null;
}

export interface AutonomyControlTimelineItem {
  id: string;
  kind: "decision" | "contract" | "policy" | "override" | "escalation" | "history";
  title: string;
  description: string;
  status: string;
  time: string | null;
  href?: string;
}

export interface ProjectAutonomyTaskItem {
  taskId: string;
  title: string;
  status: string;
  mode: DerivedAutonomySnapshot["mode"];
  confidenceScore: number;
  confidenceBand: DerivedAutonomySnapshot["confidenceBand"];
  riskLevel: string;
  sensitiveScopeFlags: string[];
  blockedByPolicy: boolean;
  awaitingApproval: boolean;
  autoExecuted: boolean;
  escalatedToHuman: boolean;
  summary: string;
}

export interface ProjectAutonomySummary {
  projectId: string;
  projectName: string;
  taskCount: number;
  confidenceAverage: number;
  riskDistribution: Record<"high" | "medium" | "low" | "unknown", number>;
  awaitingApprovalCount: number;
  autoExecutedCount: number;
  blockedCount: number;
  escalatedCount: number;
  tasks: ProjectAutonomyTaskItem[];
}

function computeConfidenceScore({
  dispatchEvaluation,
  resultEvaluation,
  riskLevel,
  missingContextCount,
  riskFlagCount,
  recurringFailureCount,
  retryCount,
  blockedByPolicy,
  awaitingApproval,
  reviewRequired,
  qaRequired,
  escalatedToHuman,
  memoryCount
}: {
  dispatchEvaluation: DispatchEvaluation | null;
  resultEvaluation: ResultEvaluation | null;
  riskLevel: string;
  missingContextCount: number;
  riskFlagCount: number;
  recurringFailureCount: number;
  retryCount: number;
  blockedByPolicy: boolean;
  awaitingApproval: boolean;
  reviewRequired: boolean;
  qaRequired: boolean;
  escalatedToHuman: boolean;
  memoryCount: number;
}) {
  let score = 0.56;

  if (dispatchEvaluation?.ready_for_execution) {
    score += 0.14;
  }

  if (dispatchEvaluation?.policy_decision.allow_auto_execute) {
    score += 0.08;
  }

  if (riskLevel === "low") {
    score += 0.12;
  } else if (riskLevel === "medium") {
    score -= 0.05;
  } else if (riskLevel === "high") {
    score -= 0.18;
  } else {
    score -= 0.08;
  }

  score -= Math.min(missingContextCount * 0.06, 0.18);
  score -= Math.min(riskFlagCount * 0.04, 0.16);
  score -= Math.min(recurringFailureCount * 0.08, 0.16);
  score -= Math.min(retryCount * 0.03, 0.15);
  score += Math.min(memoryCount * 0.015, 0.08);

  if (blockedByPolicy) {
    score -= 0.18;
  }

  if (awaitingApproval) {
    score -= 0.14;
  }

  if (reviewRequired) {
    score -= 0.11;
  }

  if (qaRequired) {
    score -= 0.07;
  }

  if (escalatedToHuman || resultEvaluation?.status === "needs_rework") {
    score -= 0.12;
  }

  return clamp(score, 0.08, 0.97);
}

function confidenceBand(score: number) {
  if (score >= 0.76) {
    return "high";
  }

  if (score >= 0.5) {
    return "medium";
  }

  return "low";
}

function deriveMode({
  blockedByPolicy,
  awaitingApproval,
  reviewRequired,
  qaRequired,
  autoExecutable
}: {
  blockedByPolicy: boolean;
  awaitingApproval: boolean;
  reviewRequired: boolean;
  qaRequired: boolean;
  autoExecutable: boolean;
}) {
  if (blockedByPolicy) {
    return "blocked";
  }

  if (awaitingApproval) {
    return "approval_required";
  }

  if (reviewRequired || qaRequired) {
    return "review_required";
  }

  if (autoExecutable) {
    return "auto_execute";
  }

  return "manual";
}

function allowedActionsFromPolicy(policyDecision: PolicyDecision, mode: DerivedAutonomySnapshot["mode"]) {
  const actions: string[] = [];

  if (mode === "blocked") {
    return ["Manual intervention only"];
  }

  if (policyDecision.allow_auto_execute) {
    actions.push("Auto execute");
  }

  if (policyDecision.require_review) {
    actions.push("Queue review");
  }

  if (policyDecision.require_qa) {
    actions.push("Queue QA");
  }

  if (policyDecision.require_approval) {
    actions.push("Request approval");
  }

  if (policyDecision.retry_allowed) {
    actions.push(`Retry up to ${policyDecision.max_retry}`);
  }

  if (policyDecision.max_chain_depth > 0 && policyDecision.allow_auto_execute) {
    actions.push(`Advance chain depth ${policyDecision.max_chain_depth}`);
  }

  if (policyDecision.escalate || policyDecision.manual_break_required) {
    actions.push("Escalate to human");
  }

  return actions.length > 0 ? actions : ["Manual handling"];
}

function deriveSensitiveScopeFlags({
  task,
  policyDecision,
  dispatchEvaluation,
  resultEvaluation,
  loopDecision,
  taskMemory
}: {
  task: Task;
  policyDecision: PolicyDecision;
  dispatchEvaluation: DispatchEvaluation | null;
  resultEvaluation: ResultEvaluation | null;
  loopDecision: LoopDecision | null;
  taskMemory: TaskMemory | null;
}) {
  const combinedText = [
    task.title,
    task.task_type,
    task.instructions,
    ...(dispatchEvaluation?.risk_flags || []),
    ...(dispatchEvaluation?.missing_context || []),
    ...(resultEvaluation?.risk_flags || []),
    ...(policyDecision.reason_codes || []),
    ...(taskMemory?.entries.flatMap((entry) => [entry.subject, entry.summary, ...entry.constraints]) || [])
  ]
    .join(" ")
    .toLowerCase();

  const flags = new Set<string>();

  if (policyDecision.require_approval || task.status === "awaiting_approval") {
    flags.add("Approval boundary");
  }

  if (productionTerms.some((term) => combinedText.includes(term))) {
    flags.add("Production scope");
  }

  if (securityTerms.some((term) => combinedText.includes(term))) {
    flags.add("Security surface");
  }

  if (
    resultEvaluation?.risk_flags.includes("scope_deviation") ||
    taskMemory?.entries.some((entry) =>
      [entry.subject, entry.summary, entry.decision_impact].join(" ").toLowerCase().includes("scope")
    )
  ) {
    flags.add("Scope deviation risk");
  }

  if ((loopDecision?.failure_patterns || []).some((pattern) => pattern.recurring)) {
    flags.add("Recurring failure pattern");
  }

  return Array.from(flags);
}

function buildDecisionSummary({
  task,
  mode,
  riskLevel,
  autoExecutable,
  blockedByPolicy,
  awaitingApproval,
  reviewRequired,
  qaRequired,
  escalatedToHuman,
  policyDecision,
  loopDecision
}: {
  task: Task;
  mode: DerivedAutonomySnapshot["mode"];
  riskLevel: string;
  autoExecutable: boolean;
  blockedByPolicy: boolean;
  awaitingApproval: boolean;
  reviewRequired: boolean;
  qaRequired: boolean;
  escalatedToHuman: boolean;
  policyDecision: PolicyDecision;
  loopDecision: LoopDecision | null;
}) {
  if (blockedByPolicy) {
    return `${task.title} is blocked because the current policy decision rejected autonomous execution at ${sentenceCase(riskLevel)} risk.`;
  }

  if (awaitingApproval) {
    return `${task.title} is waiting for operator approval before any autonomous action can continue.`;
  }

  if (reviewRequired || qaRequired) {
    return `${task.title} remains in ${sentenceCase(mode)} because review controls are active before execution can continue.`;
  }

  if (escalatedToHuman) {
    return `${task.title} was escalated to a human after the loop controller detected a condition outside the current autonomy contract.`;
  }

  if (autoExecutable) {
    const nextAction = loopDecision?.next_action ? sentenceCase(loopDecision.next_action) : "Auto execute";
    return `${task.title} qualifies for selective autonomy. The current contract allows the system to ${nextAction.toLowerCase()} within the configured retry and chain limits.`;
  }

  if (policyDecision.manual_break_required) {
    return `${task.title} is held for manual handling because the current policy decision requires a human break point.`;
  }

  return `${task.title} is visible to operators, but the current data does not fully clear it for autonomous execution.`;
}

function buildContributingFactors({
  dispatchEvaluation,
  resultEvaluation,
  reviewerDecision,
  qaDecision,
  loopDecision,
  sensitiveScopeFlags
}: {
  dispatchEvaluation: DispatchEvaluation | null;
  resultEvaluation: ResultEvaluation | null;
  reviewerDecision: ReviewerDecision | null;
  qaDecision: QADecision | null;
  loopDecision: LoopDecision | null;
  sensitiveScopeFlags: string[];
}) {
  return uniqueStrings([
    ...(dispatchEvaluation?.policy_decision.reason_codes || []).map(sentenceCase),
    ...(dispatchEvaluation?.missing_context || []),
    ...(dispatchEvaluation?.risk_flags || []).map(sentenceCase),
    ...(resultEvaluation?.risk_flags || []).map(sentenceCase),
    ...(reviewerDecision?.risky_changes || []),
    ...(reviewerDecision?.notes || []),
    ...(qaDecision?.missing_checks || []),
    ...(qaDecision?.potential_regressions || []),
    ...(loopDecision?.reasons || []),
    ...sensitiveScopeFlags
  ]).slice(0, 8);
}

function buildEvidence({
  policyDecision,
  loopDecision,
  dispatchEvaluation,
  taskMemory
}: {
  policyDecision: PolicyDecision;
  loopDecision: LoopDecision | null;
  dispatchEvaluation: DispatchEvaluation | null;
  taskMemory: TaskMemory | null;
}) {
  return uniqueStrings([
    ...flattenStrings(policyDecision.evidence),
    ...(dispatchEvaluation?.constraints || []),
    ...(loopDecision?.bug_triage?.evidence || []),
    ...(loopDecision?.failure_patterns.flatMap((pattern) => pattern.evidence) || []),
    ...(taskMemory?.entries.flatMap((entry) =>
      entry.evidence_refs.map((ref) => ref.note || ref.artifact_path || ref.ref_id || ref.source_type)
    ) || [])
  ]).slice(0, 8);
}

function buildHistoryRefs(history: TaskHistory) {
  const eventRefs = [...history.entries]
    .filter(
      (entry) =>
        entry.entry_type.includes("loop.") ||
        entry.entry_type.includes("result_evaluation") ||
        entry.entry_type.includes("dispatch_evaluation") ||
        entry.entry_type.includes("escalat")
    )
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 4)
    .map((entry) => ({
      id: `history-${entry.timestamp}-${entry.entry_type}`,
      label: sentenceCase(entry.entry_type),
      detail: entry.summary || "Inspect the linked evidence for the recorded decision.",
      href: entry.execution_run_id ? `/runs/${entry.execution_run_id}` : `/tasks/${history.task_id}`
    }));

  const loopRefs = [...history.loop_history]
    .filter((entry) => entry.execution_run_id || entry.summary || entry.failure_pattern_key)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, 2)
    .map((entry) => ({
      id: `loop-${entry.id}`,
      label: sentenceCase(entry.action),
      detail:
        entry.summary ||
        sentenceCase(entry.failure_pattern_key || entry.bug_category || "Loop transition"),
      href: entry.execution_run_id ? `/runs/${entry.execution_run_id}` : `/tasks/${history.task_id}`
    }));

  return [...eventRefs, ...loopRefs].slice(0, 5);
}

function buildMemoryRefs(taskMemory: TaskMemory | null) {
  return (taskMemory?.entries || []).slice(0, 4).map((entry, index) => ({
    id: `memory-${index}-${entry.subject}`,
    label: entry.subject,
    detail: entry.summary,
    href: "#task-memory"
  }));
}

function deriveContract({
  mode,
  policyDecision,
  approvalRequired,
  reviewRequired,
  qaRequired,
  evaluatedAt
}: {
  mode: DerivedAutonomySnapshot["mode"];
  policyDecision: PolicyDecision;
  approvalRequired: boolean;
  reviewRequired: boolean;
  qaRequired: boolean;
  evaluatedAt: string | null;
}) {
  return {
    executionMode:
      mode === "blocked"
        ? "Policy blocked"
        : mode === "approval_required"
          ? "Approval hold"
          : mode === "review_required"
            ? "Review hold"
            : mode === "auto_execute"
              ? "Selective autonomy"
              : "Manual handling",
    allowedActions: allowedActionsFromPolicy(policyDecision, mode),
    retryLimit: policyDecision.retry_allowed ? policyDecision.max_retry : 0,
    approvalStatus: approvalRequired
      ? "Awaiting approval"
      : reviewRequired || qaRequired
        ? "Conditional clearance"
        : "Clear for current contract",
    expirationAt: computeExpiration(evaluatedAt, policyDecision.loop_timeout_seconds)
  };
}

function hasAutonomousAction(history: TaskHistory) {
  return (
    history.loop_history.some((entry) =>
      ["re_execute", "create_follow_up_task", "chain_next_task"].includes(entry.action)
    ) ||
    history.entries.some((entry) =>
      ["loop.retry_scheduled", "task.follow_up_created", "task.chain_advanced"].includes(
        entry.entry_type
      )
    )
  );
}

export function buildTaskAutonomySnapshot(task: Task, history: TaskHistory, taskMemory: TaskMemory | null) {
  const dispatchEvaluation = latestTaskEntryPayload<DispatchEvaluation>(
    history,
    "dispatch_evaluation.recorded"
  );
  const resultEvaluation = latestTaskEntryPayload<ResultEvaluation>(
    history,
    "result_evaluation.recorded"
  );
  const reviewerDecision = pickReviewerDecision(history, resultEvaluation);
  const qaDecision = pickQADecision(history, resultEvaluation);
  const loopDecision = pickLoopDecision(history, resultEvaluation);
  const policyDecision =
    dispatchEvaluation?.policy_decision ||
    resultEvaluation?.policy_decision ||
    loopDecision?.policy_decision ||
    defaultPolicyDecision();
  const riskLevel = dispatchEvaluation?.risk_level || deriveRiskLevel(null, resultEvaluation, null);
  const blockedByPolicy =
    policyDecision.block || dispatchEvaluation?.status === "dispatch_blocked" || task.status === "blocked";
  const awaitingApproval =
    policyDecision.require_approval || task.status === "awaiting_approval";
  const reviewRequired =
    policyDecision.require_review ||
    reviewerDecision?.status === "review_required" ||
    task.status === "awaiting_review" ||
    task.status === "review_required";
  const qaRequired =
    policyDecision.require_qa ||
    qaDecision?.status === "qa_pending" ||
    task.status === "qa_pending";
  const escalatedToHuman =
    policyDecision.escalate ||
    loopDecision?.requires_human === true ||
    history.loop_state?.status === "escalated";
  const autoExecutable =
    policyDecision.allow_auto_execute &&
    !blockedByPolicy &&
    !awaitingApproval &&
    !reviewRequired &&
    !qaRequired;
  const autoExecuted = autoExecutable && hasAutonomousAction(history);
  const mode = deriveMode({
    blockedByPolicy,
    awaitingApproval,
    reviewRequired,
    qaRequired,
    autoExecutable
  });
  const sensitiveScopeFlags = deriveSensitiveScopeFlags({
    task,
    policyDecision,
    dispatchEvaluation,
    resultEvaluation,
    loopDecision,
    taskMemory
  });
  const confidenceScore = computeConfidenceScore({
    dispatchEvaluation,
    resultEvaluation,
    riskLevel,
    missingContextCount: dispatchEvaluation?.missing_context.length || 0,
    riskFlagCount:
      (dispatchEvaluation?.risk_flags.length || 0) + (resultEvaluation?.risk_flags.length || 0),
    recurringFailureCount:
      loopDecision?.failure_patterns.filter((pattern) => pattern.recurring).length || 0,
    retryCount: history.loop_state?.retry_count || 0,
    blockedByPolicy,
    awaitingApproval,
    reviewRequired,
    qaRequired,
    escalatedToHuman,
    memoryCount: taskMemory?.entries.length || 0
  });
  const evaluatedAt =
    dispatchEvaluation?.evaluated_at ||
    resultEvaluation?.evaluated_at ||
    history.loop_state?.last_transition_at ||
    latestLoopHistory(history)?.created_at ||
    null;
  const contract = deriveContract({
    mode,
    policyDecision,
    approvalRequired: awaitingApproval,
    reviewRequired,
    qaRequired,
    evaluatedAt
  });

  return {
    taskId: task.id,
    title: task.title,
    mode,
    confidenceScore,
    confidenceBand: confidenceBand(confidenceScore),
    riskLevel,
    approvalRequired: awaitingApproval,
    reviewRequired,
    qaRequired,
    blockedByPolicy,
    autoExecutable,
    autoExecuted,
    escalatedToHuman,
    sensitiveScopeFlags,
    allowedActions: contract.allowedActions,
    policyReasonCodes: policyDecision.reason_codes,
    decisionSummary: buildDecisionSummary({
      task,
      mode,
      riskLevel,
      autoExecutable,
      blockedByPolicy,
      awaitingApproval,
      reviewRequired,
      qaRequired,
      escalatedToHuman,
      policyDecision,
      loopDecision
    }),
    contributingFactors: buildContributingFactors({
      dispatchEvaluation,
      resultEvaluation,
      reviewerDecision,
      qaDecision,
      loopDecision,
      sensitiveScopeFlags
    }),
    evidence: buildEvidence({
      policyDecision,
      loopDecision,
      dispatchEvaluation,
      taskMemory
    }),
    historyRefs: buildHistoryRefs(history),
    memoryRefs: buildMemoryRefs(taskMemory),
    contract,
    evaluatedAt
  } satisfies DerivedAutonomySnapshot;
}

export function buildAutonomyControlTimeline(
  history: TaskHistory,
  snapshot: DerivedAutonomySnapshot
) {
  const items: AutonomyControlTimelineItem[] = [];
  const dispatchEntry = latestTaskEntry(history, "dispatch_evaluation.recorded");
  const resultEntry = latestTaskEntry(history, "result_evaluation.recorded");
  const loopEntry = latestTaskEntry(history, "loop.decision_recorded");

  if (dispatchEntry) {
    items.push({
      id: `dispatch-${dispatchEntry.timestamp}`,
      kind: "decision",
      title: "Autonomy decision issued",
      description: "The control plane evaluated readiness, policy gates, and risk before dispatch.",
      status: dispatchEntry.task_status || "progressed",
      time: dispatchEntry.timestamp,
      href: `/tasks/${history.task_id}`
    });

    items.push({
      id: `contract-${dispatchEntry.timestamp}`,
      kind: "contract",
      title: "Execution contract issued",
      description: `${snapshot.contract.executionMode} with ${snapshot.contract.retryLimit} retries and ${snapshot.contract.allowedActions.length} allowed actions.`,
      status: snapshot.mode === "auto_execute" ? "ready_for_dispatch" : "awaiting_review",
      time: dispatchEntry.timestamp,
      href: `/tasks/${history.task_id}`
    });
  }

  if (snapshot.blockedByPolicy) {
    items.push({
      id: `policy-${snapshot.taskId}`,
      kind: "policy",
      title: "Policy rejection recorded",
      description:
        snapshot.policyReasonCodes.length > 0
          ? snapshot.policyReasonCodes.map(sentenceCase).join(", ")
          : "The policy layer blocked execution under the current contract.",
      status: "dispatch_blocked",
      time: loopEntry?.timestamp || resultEntry?.timestamp || dispatchEntry?.timestamp || snapshot.evaluatedAt,
      href: `/tasks/${history.task_id}`
    });
  }

  if (resultEntry) {
    items.push({
      id: `result-${resultEntry.timestamp}`,
      kind: "decision",
      title: "Execution result reviewed",
      description: "Reviewer, QA, and loop outcomes were folded back into the autonomy decision.",
      status: resultEntry.task_status || "progressed",
      time: resultEntry.timestamp,
      href: resultEntry.execution_run_id ? `/runs/${resultEntry.execution_run_id}` : `/tasks/${history.task_id}`
    });
  }

  if (snapshot.escalatedToHuman) {
    items.push({
      id: `escalation-${snapshot.taskId}`,
      kind: "escalation",
      title: "Escalated to human",
      description: "The autonomy controller handed this task back to a human operator.",
      status: "escalated",
      time:
        loopEntry?.timestamp ||
        latestLoopHistory(history)?.created_at ||
        resultEntry?.timestamp ||
        snapshot.evaluatedAt,
      href: loopEntry?.execution_run_id ? `/runs/${loopEntry.execution_run_id}` : `/tasks/${history.task_id}`
    });
  }

  const supportingHistory = [...history.loop_history]
    .filter((entry) =>
      ["re_execute", "manual_retry", "create_follow_up_task", "chain_next_task", "escalate_to_human"].includes(
        entry.action
      )
    )
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, 3)
    .map((entry) => ({
      id: `support-${entry.id}`,
      kind: "history",
      title: sentenceCase(entry.action),
      description:
        entry.summary ||
        `Loop controller recorded ${sentenceCase(entry.action)} at retry ${entry.retry_count}.`,
      status:
        entry.action === "escalate_to_human"
          ? "escalated"
          : entry.action === "re_execute"
            ? "retry_scheduled"
            : entry.action,
      time: entry.created_at,
      href: entry.execution_run_id ? `/runs/${entry.execution_run_id}` : `/tasks/${history.task_id}`
    } satisfies AutonomyControlTimelineItem));

  return [...items, ...supportingHistory].sort((left, right) =>
    (right.time || "").localeCompare(left.time || "")
  );
}

export function buildProjectAutonomySummary({
  projectId,
  projectName,
  tasks,
  snapshots
}: {
  projectId: string;
  projectName: string;
  tasks: Task[];
  snapshots: DerivedAutonomySnapshot[];
}) {
  const taskItems = tasks.map((task) => {
    const snapshot = snapshots.find((item) => item.taskId === task.id);

    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      mode: snapshot?.mode || "manual",
      confidenceScore: snapshot?.confidenceScore || 0.2,
      confidenceBand: snapshot?.confidenceBand || "low",
      riskLevel: snapshot?.riskLevel || "unknown",
      sensitiveScopeFlags: snapshot?.sensitiveScopeFlags || [],
      blockedByPolicy: snapshot?.blockedByPolicy || false,
      awaitingApproval: snapshot?.approvalRequired || false,
      autoExecuted: snapshot?.autoExecuted || false,
      escalatedToHuman: snapshot?.escalatedToHuman || false,
      summary: snapshot?.decisionSummary || `${task.title} has not emitted an autonomy decision yet.`
    } satisfies ProjectAutonomyTaskItem;
  });

  const confidenceAverage =
    snapshots.length === 0
      ? 0
      : snapshots.reduce((sum, snapshot) => sum + snapshot.confidenceScore, 0) / snapshots.length;

  return {
    projectId,
    projectName,
    taskCount: tasks.length,
    confidenceAverage,
    riskDistribution: {
      high: taskItems.filter((item) => item.riskLevel === "high").length,
      medium: taskItems.filter((item) => item.riskLevel === "medium").length,
      low: taskItems.filter((item) => item.riskLevel === "low").length,
      unknown: taskItems.filter((item) => item.riskLevel === "unknown").length
    },
    awaitingApprovalCount: taskItems.filter((item) => item.awaitingApproval).length,
    autoExecutedCount: taskItems.filter((item) => item.autoExecuted).length,
    blockedCount: taskItems.filter((item) => item.blockedByPolicy).length,
    escalatedCount: taskItems.filter((item) => item.escalatedToHuman).length,
    tasks: taskItems.sort((left, right) => right.confidenceScore - left.confidenceScore)
  } satisfies ProjectAutonomySummary;
}
