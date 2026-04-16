import type {
  DispatchEvaluation,
  EventRecord,
  ExecutionRun,
  MemoryEntry,
  ProjectMemory,
  QADecision,
  ResultEvaluation,
  ReviewerDecision,
  Task,
  TaskMemory,
  TaskSession,
  ValidationCheck
} from "@/lib/api/types";

type UnknownRecord = Record<string, unknown>;

const changedFileKeys = [
  "changed_files",
  "files_changed",
  "modified_files",
  "touched_files",
  "paths",
  "artifacts"
];

const validationKeys = [
  "validation_checks",
  "qa_checks",
  "test_results",
  "tests",
  "checks"
];

const dispatchStatuses = new Set([
  "ready_for_dispatch",
  "needs_context",
  "dispatch_blocked",
  "awaiting_approval",
  "awaiting_review"
]);

const failureTerms = [
  "blocked",
  "dependency",
  "approval",
  "missing",
  "timeout",
  "test",
  "assert",
  "validation",
  "regression"
];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function sortEventsDesc(events: EventRecord[]) {
  return [...events].sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
}

function latestEventPayload<T>(events: EventRecord[], eventType: string): T | null {
  const match = sortEventsDesc(events).find((event) => event.event_type === eventType);

  if (!match || !isRecord(match.payload)) {
    return null;
  }

  return match.payload as T;
}

function payloadChecks(payload: UnknownRecord): ValidationCheck[] {
  for (const key of validationKeys) {
    const value = payload[key];

    if (!Array.isArray(value)) {
      continue;
    }

    const checks = value
      .map((item) => {
        if (typeof item === "string") {
          return {
            acceptance_criterion: item,
            status: "reported",
            evidence: null
          };
        }

        if (!isRecord(item)) {
          return null;
        }

        const acceptanceCriterion =
          typeof item.acceptance_criterion === "string"
            ? item.acceptance_criterion
            : typeof item.name === "string"
              ? item.name
              : typeof item.label === "string"
                ? item.label
                : typeof item.test === "string"
                  ? item.test
                  : null;

        if (!acceptanceCriterion) {
          return null;
        }

        return {
          acceptance_criterion: acceptanceCriterion,
          status: typeof item.status === "string" ? item.status : "reported",
          evidence: typeof item.evidence === "string" ? item.evidence : null
        };
      })
      .filter((item): item is ValidationCheck => Boolean(item));

    if (checks.length > 0) {
      return checks;
    }
  }

  return [];
}

function entryMatches(entry: MemoryEntry, terms: string[]) {
  const haystack = [
    entry.subject,
    entry.summary,
    entry.source_type,
    entry.decision_impact,
    entry.constraints.join(" ")
  ]
    .join(" ")
    .toLowerCase();

  return terms.some((term) => haystack.includes(term));
}

export interface FlowItem {
  id: string;
  kind:
    | "task"
    | "dispatch"
    | "decision"
    | "contract"
    | "policy"
    | "session"
    | "run"
    | "retry"
    | "review"
    | "qa"
    | "escalation";
  label: string;
  description: string;
  status: string;
  time: string | null;
  attemptNo?: number;
}

export interface TaskSummaryItem {
  taskId: string;
  summary: string;
  generatedAt: string | null;
  entryCount: number;
  title?: string;
}

export function getDispatchEvaluation(events: EventRecord[]) {
  return latestEventPayload<DispatchEvaluation>(events, "dispatch_evaluation.recorded");
}

export function getResultEvaluation(events: EventRecord[]) {
  return latestEventPayload<ResultEvaluation>(events, "result_evaluation.recorded");
}

export function getReviewerDecision(events: EventRecord[]) {
  return latestEventPayload<ReviewerDecision>(events, "reviewer.decision_recorded");
}

export function getQADecision(events: EventRecord[]) {
  return latestEventPayload<QADecision>(events, "qa.decision_recorded");
}

export function deriveDispatchStatus(task: Task, dispatchEvaluation: DispatchEvaluation | null) {
  if (dispatchEvaluation?.status) {
    return dispatchEvaluation.status;
  }

  if (dispatchStatuses.has(task.status)) {
    return task.status;
  }

  if (task.status === "pending") {
    return "not_evaluated";
  }

  return "progressed";
}

export function deriveRiskLevel(
  dispatchEvaluation: DispatchEvaluation | null,
  resultEvaluation: ResultEvaluation | null,
  run: ExecutionRun | null
) {
  if (dispatchEvaluation?.risk_level) {
    return dispatchEvaluation.risk_level;
  }

  if (resultEvaluation) {
    if (
      resultEvaluation.risk_flags.includes("scope_deviation") ||
      resultEvaluation.risk_flags.includes("execution_failure") ||
      resultEvaluation.risk_flags.includes("run_blocked") ||
      resultEvaluation.risk_flags.length >= 3
    ) {
      return "high";
    }

    if (resultEvaluation.risk_flags.length > 0) {
      return "medium";
    }

    return "low";
  }

  if (run?.error_message || ["failed", "blocked", "timeout"].includes(run?.status || "")) {
    return "medium";
  }

  return "unknown";
}

export function deriveFailureType(
  run: ExecutionRun | null,
  resultEvaluation: ResultEvaluation | null
) {
  const loweredError = (run?.error_message || "").toLowerCase();

  if (resultEvaluation?.risk_flags.includes("run_blocked")) {
    return "blocked";
  }

  if (resultEvaluation?.risk_flags.includes("missing_validation_evidence")) {
    return "validation_gap";
  }

  if (resultEvaluation?.risk_flags.includes("potential_regressions")) {
    return "regression_risk";
  }

  if (resultEvaluation?.risk_flags.includes("execution_failure")) {
    return "execution_failure";
  }

  if (loweredError.includes("test") || loweredError.includes("assert")) {
    return "test_failure";
  }

  if (failureTerms.some((term) => loweredError.includes(term))) {
    return "blocked";
  }

  if (run?.status === "failed") {
    return "execution_failure";
  }

  if (run?.status === "blocked") {
    return "blocked";
  }

  return "none";
}

export function extractChangedFiles(payload: Record<string, unknown>) {
  const files: string[] = [];

  for (const key of changedFileKeys) {
    const value = payload[key];

    if (typeof value === "string") {
      files.push(value);
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          files.push(item);
          continue;
        }

        if (!isRecord(item)) {
          continue;
        }

        for (const field of ["path", "file", "name"]) {
          if (typeof item[field] === "string") {
            files.push(item[field]);
          }
        }
      }
      continue;
    }

    if (!isRecord(value)) {
      continue;
    }

    for (const field of ["path", "file", "name"]) {
      if (typeof value[field] === "string") {
        files.push(value[field]);
      }
    }
  }

  return uniqueStrings(files);
}

export function extractValidationChecks(
  resultEvaluation: ResultEvaluation | null,
  run: ExecutionRun,
  session: TaskSession | null,
  events: EventRecord[]
) {
  if (resultEvaluation?.qa_decision.validation_checks.length) {
    return resultEvaluation.qa_decision.validation_checks;
  }

  const directChecks = payloadChecks(run.output_payload);
  if (directChecks.length) {
    return directChecks;
  }

  if (session) {
    const sessionChecks = payloadChecks(session.metadata);
    if (sessionChecks.length) {
      return sessionChecks;
    }
  }

  for (const event of sortEventsDesc(events)) {
    const eventChecks = payloadChecks(event.payload);
    if (eventChecks.length) {
      return eventChecks;
    }
  }

  return [];
}

export function collectFailureReasons(
  run: ExecutionRun,
  resultEvaluation: ResultEvaluation | null,
  reviewerDecision: ReviewerDecision | null,
  qaDecision: QADecision | null
) {
  return uniqueStrings([
    ...flattenStrings(run.error_message),
    ...(resultEvaluation?.risk_flags || []),
    ...(reviewerDecision?.risky_changes || []),
    ...(qaDecision?.missing_checks || []),
    ...(qaDecision?.potential_regressions || [])
  ]);
}

export function buildExecutionFlow(
  task: Task,
  sessions: TaskSession[],
  runs: ExecutionRun[],
  dispatchEvaluation: DispatchEvaluation | null,
  resultEvaluation: ResultEvaluation | null,
  reviewerDecision: ReviewerDecision | null,
  qaDecision: QADecision | null
) {
  const items: FlowItem[] = [
    {
      id: `${task.id}-created`,
      kind: "task",
      label: "Task created",
      description: `${task.task_type} task opened with status '${task.status}'.`,
      status: task.status,
      time: task.created_at
    }
  ];

  if (dispatchEvaluation) {
    items.push({
      id: `${task.id}-dispatch`,
      kind: "dispatch",
      label: "Dispatch evaluation",
      description: dispatchEvaluation.ready_for_execution
        ? "Task is ready for execution."
        : "Dispatch evaluation identified context, policy, or dependency risk.",
      status: dispatchEvaluation.status,
      time: dispatchEvaluation.evaluated_at
    });

    items.push({
      id: `${task.id}-contract`,
      kind: "contract",
      label: "Execution contract issued",
      description: dispatchEvaluation.policy_decision.allow_auto_execute
        ? `Auto execution allowed with retry limit ${dispatchEvaluation.policy_decision.max_retry}.`
        : "Execution stayed under a constrained or manual contract.",
      status: dispatchEvaluation.policy_decision.allow_auto_execute
        ? "ready_for_dispatch"
        : dispatchEvaluation.policy_decision.block
          ? "dispatch_blocked"
          : dispatchEvaluation.policy_decision.require_approval
            ? "awaiting_approval"
            : "awaiting_review",
      time: dispatchEvaluation.evaluated_at
    });

    if (dispatchEvaluation.policy_decision.block) {
      items.push({
        id: `${task.id}-policy`,
        kind: "policy",
        label: "Policy rejection",
        description:
          dispatchEvaluation.policy_decision.reason_codes[0] ||
          "Policy blocked execution under the current contract.",
        status: "dispatch_blocked",
        time: dispatchEvaluation.evaluated_at
      });
    }
  }

  const runsBySession = new Map<string, ExecutionRun[]>();
  for (const run of runs) {
    const sessionRuns = runsBySession.get(run.task_session_id) || [];
    sessionRuns.push(run);
    runsBySession.set(run.task_session_id, sessionRuns);
  }

  const orderedSessions = [...sessions].sort((left, right) =>
    left.started_at.localeCompare(right.started_at)
  );

  for (const session of orderedSessions) {
    items.push({
      id: `${session.id}-session`,
      kind: "session",
      label: "Session started",
      description: session.artifact_path
        ? `Artifact tracked at ${session.artifact_path}.`
        : "Worker session opened for this task.",
      status: session.status,
      time: session.started_at
    });

    const sessionRuns = [...(runsBySession.get(session.id) || [])].sort((left, right) =>
      (left.started_at || left.created_at).localeCompare(right.started_at || right.created_at)
    );

    sessionRuns.forEach((run, index) => {
      items.push({
        id: `${run.id}-run`,
        kind: "run",
        label: `Execution attempt ${run.attempt_no}`,
        description: run.error_message
          ? run.error_message
          : run.worker_name
            ? `Worker ${run.worker_name} executed this attempt.`
            : "Execution attempt recorded without worker metadata.",
        status: run.status,
        time: run.started_at || run.created_at,
        attemptNo: run.attempt_no
      });

      if (
        index < sessionRuns.length - 1 &&
        ["failed", "blocked", "timeout"].includes(run.status)
      ) {
        items.push({
          id: `${run.id}-retry`,
          kind: "retry",
          label: "Retry loop",
          description: "A follow-up attempt was scheduled after this failure signal.",
          status: "retrying",
          time: sessionRuns[index + 1].started_at || sessionRuns[index + 1].created_at,
          attemptNo: sessionRuns[index + 1].attempt_no
        });
      }
    });
  }

  if (reviewerDecision) {
    items.push({
      id: `${task.id}-review`,
      kind: "review",
      label: "Reviewer decision",
      description:
        reviewerDecision.notes[0] ||
        reviewerDecision.risky_changes[0] ||
        "Reviewer decision recorded for this execution path.",
      status: reviewerDecision.status,
      time: resultEvaluation?.evaluated_at || task.updated_at
    });
  }

  if (qaDecision) {
    items.push({
      id: `${task.id}-qa`,
      kind: "qa",
      label: "QA decision",
      description:
        qaDecision.missing_checks[0] ||
        qaDecision.potential_regressions[0] ||
        "QA decision recorded for this execution path.",
      status: qaDecision.status,
      time: resultEvaluation?.evaluated_at || task.updated_at
    });
  }

  if (resultEvaluation) {
    items.push({
      id: `${task.id}-decision`,
      kind: "decision",
      label: "Autonomy decision issued",
      description: resultEvaluation.loop_decision
        ? `Loop controller chose ${resultEvaluation.loop_decision.next_action.replace(/_/g, " ")}.`
        : "Result evaluation refreshed the autonomy posture for this task.",
      status: resultEvaluation.status,
      time: resultEvaluation.evaluated_at
    });

    if (resultEvaluation.policy_decision.block) {
      items.push({
        id: `${task.id}-result-policy`,
        kind: "policy",
        label: "Policy rejection",
        description:
          resultEvaluation.policy_decision.reason_codes[0] ||
          "The result evaluator blocked this execution path.",
        status: "blocked",
        time: resultEvaluation.evaluated_at
      });
    }

    if (resultEvaluation.loop_decision?.requires_human || resultEvaluation.policy_decision.escalate) {
      items.push({
        id: `${task.id}-escalation`,
        kind: "escalation",
        label: "Escalated to human",
        description:
          resultEvaluation.loop_decision?.reasons[0] ||
          "The execution path crossed a threshold that requires human intervention.",
        status: "escalated",
        time: resultEvaluation.evaluated_at
      });
    }
  }

  return items.sort((left, right) => (left.time || "").localeCompare(right.time || ""));
}

export function getImportantDecisionEntries(entries: MemoryEntry[]) {
  return entries.filter((entry) =>
    entryMatches(entry, [
      "decision",
      "policy",
      "approval",
      "require_review",
      "require_qa",
      "preserve_constraints",
      "increase_review",
      "policy_gate"
    ])
  );
}

export function getBugPatternEntries(entries: MemoryEntry[]) {
  return entries.filter((entry) =>
    entryMatches(entry, [
      "bug",
      "failed",
      "failure",
      "error",
      "regression",
      "watch_bug_pattern",
      "execution_history"
    ])
  );
}

export function buildTaskSummaryItems(taskMemories: TaskMemory[]) {
  return taskMemories
    .filter((memory) => memory.summary)
    .map((memory) => ({
      taskId: memory.task_id,
      summary: memory.summary || "No task summary available.",
      generatedAt: memory.generated_at,
      entryCount: memory.entries.length,
      title: memory.entries[0]?.subject
    }))
    .sort((left, right) => (right.generatedAt || "").localeCompare(left.generatedAt || ""));
}

export function collectMemoryEntries(
  projectMemory: ProjectMemory | null,
  taskMemory: TaskMemory | null,
  taskMemories: TaskMemory[] = []
) {
  return [
    ...(projectMemory?.entries || []),
    ...(taskMemory?.entries || []),
    ...taskMemories.flatMap((memory) => memory.entries)
  ];
}
