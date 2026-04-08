"use client";

import Link from "next/link";
import { useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import type {
  ExecutionRun,
  ResultEvaluation,
  Task,
  TaskDependency,
  TaskHistory,
  TaskHistoryEvent,
  TaskLoopHistoryEntry,
  TaskRelationship,
  TaskSession
} from "@/lib/api/types";
import { cn, formatDateTime, sentenceCase, truncateId } from "@/lib/format";
import { deriveFailureType } from "@/lib/intelligence";

type UnknownRecord = Record<string, unknown>;
type TimelineTone = "default" | "loop" | "auto" | "escalation";

interface TimelineItem {
  id: string;
  category: string;
  title: string;
  description: string;
  status: string;
  time: string | null;
  retryCount: number;
  loopDepth: number;
  failureType: string;
  relatedTaskIds: string[];
  runId: string | null;
  tone: TimelineTone;
  isAutonomous: boolean;
  isEscalation: boolean;
  rank: number;
}

interface GraphNode {
  key: string;
  taskId: string;
  title: string;
  status: string;
  note: string;
  detail: string | null;
  kind: "dependency" | "parent" | "follow_up" | "chain";
}

interface TaskAutonomyPanelProps {
  task: Task;
  planTasks: Task[];
  dependencies: TaskDependency[];
  sessions: TaskSession[];
  runs: ExecutionRun[];
  history: TaskHistory;
}

const importantEventTypes = new Set([
  "dispatch_evaluation.recorded",
  "result_evaluation.recorded",
  "reviewer.decision_recorded",
  "qa.decision_recorded",
  "loop.retry_scheduled",
  "loop.manual_retry_requested",
  "loop.decision_recorded",
  "task.follow_up_created",
  "task.chain_advanced"
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(record: UnknownRecord | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function pickNumber(record: UnknownRecord | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function pickRecord(record: UnknownRecord | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (isRecord(value)) {
      return value;
    }
  }

  return null;
}

function pickStringArray(record: UnknownRecord | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (!Array.isArray(value)) {
      continue;
    }

    const strings = value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0
    );
    if (strings.length > 0) {
      return strings;
    }
  }

  return [];
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value && value.trim())))
  );
}

function taskLookupMap(task: Task, planTasks: Task[]) {
  const lookup = new Map<string, Task>();

  for (const planTask of planTasks) {
    lookup.set(planTask.id, planTask);
  }

  lookup.set(task.id, task);
  return lookup;
}

function describeTask(taskId: string, taskLookup: Map<string, Task>) {
  const relatedTask = taskLookup.get(taskId);

  return {
    label: relatedTask?.title || `Task ${truncateId(taskId, 12)}`,
    status: relatedTask?.status || "open"
  };
}

function relationshipDetail(relationship: TaskRelationship) {
  const reason = pickString(relationship.metadata, ["reason", "source_status"]);
  return reason ? sentenceCase(reason) : null;
}

function eventStatus(entry: TaskHistoryEvent) {
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const loopDecision = pickRecord(payload, ["loop_decision"]);
  const dispatchEvaluation = pickRecord(payload, ["dispatch_evaluation"]);
  const reviewerDecision = pickRecord(payload, ["reviewer_decision"]);
  const qaDecision = pickRecord(payload, ["qa_decision"]);

  return (
    pickString(loopDecision, ["status"]) ||
    pickString(dispatchEvaluation, ["status"]) ||
    pickString(reviewerDecision, ["status"]) ||
    pickString(qaDecision, ["status"]) ||
    pickString(payload, ["status", "current_action", "next_action"]) ||
    entry.task_status ||
    "recorded"
  );
}

function eventRetryCount(entry: TaskHistoryEvent) {
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const loopDecision = pickRecord(payload, ["loop_decision"]);
  const loopState = pickRecord(payload, ["loop_state"]);
  const retryResponse = pickRecord(payload, ["retry_response"]);

  return (
    pickNumber(loopDecision, ["retry_count"]) ||
    pickNumber(loopState, ["retry_count"]) ||
    pickNumber(retryResponse, ["retry_count"]) ||
    pickNumber(payload, ["retry_count"]) ||
    0
  );
}

function eventLoopDepth(entry: TaskHistoryEvent, fallbackDepth: number) {
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const loopDecision = pickRecord(payload, ["loop_decision"]);
  const loopState = pickRecord(payload, ["loop_state"]);

  return (
    pickNumber(loopDecision, ["chain_depth"]) ||
    pickNumber(loopState, ["chain_depth"]) ||
    pickNumber(payload, ["chain_depth"]) ||
    fallbackDepth
  );
}

function eventRelatedTaskIds(entry: TaskHistoryEvent, currentTaskId: string) {
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const loopDecision = pickRecord(payload, ["loop_decision"]);

  return uniqueStrings([
    pickString(payload, ["follow_up_task_id", "related_task_id"]),
    pickString(loopDecision, ["follow_up_task_id"]),
    entry.related_task_id,
    ...pickStringArray(payload, ["chained_task_ids"]),
    ...pickStringArray(loopDecision, ["chained_task_ids"])
  ]).filter((taskId) => taskId !== currentTaskId);
}

function eventFailureType(entry: TaskHistoryEvent) {
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const loopDecision = pickRecord(payload, ["loop_decision"]);
  const bugTriage = pickRecord(loopDecision, ["bug_triage"]);

  if (entry.entry_type === "result_evaluation.recorded" && payload) {
    return deriveFailureType(null, payload as unknown as ResultEvaluation);
  }

  return (
    pickString(bugTriage, ["category"]) ||
    pickString(payload, ["bug_category", "failure_pattern_key"]) ||
    "none"
  );
}

function isEscalationEntry(entry: TaskHistoryEvent) {
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const loopDecision = pickRecord(payload, ["loop_decision"]);
  const status =
    pickString(loopDecision, ["status", "next_action"]) ||
    pickString(payload, ["status", "next_action"]);

  return (
    entry.entry_type.includes("escalat") ||
    status === "escalated" ||
    status === "escalate_to_human" ||
    payload?.requires_human === true
  );
}

function isAutonomousEntry(entry: TaskHistoryEvent) {
  return [
    "loop.retry_scheduled",
    "loop.decision_recorded",
    "task.follow_up_created",
    "task.chain_advanced"
  ].includes(entry.entry_type);
}

function eventTone(entry: TaskHistoryEvent): TimelineTone {
  if (isEscalationEntry(entry)) {
    return "escalation";
  }

  if (entry.entry_type.startsWith("loop.")) {
    return "loop";
  }

  if (isAutonomousEntry(entry)) {
    return "auto";
  }

  return "default";
}

function eventTitle(entry: TaskHistoryEvent) {
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const loopDecision = pickRecord(payload, ["loop_decision"]);

  switch (entry.entry_type) {
    case "dispatch_evaluation.recorded":
      return "Dispatch evaluated";
    case "result_evaluation.recorded":
      return "Result evaluation recorded";
    case "reviewer.decision_recorded":
      return "Reviewer decision recorded";
    case "qa.decision_recorded":
      return "QA decision recorded";
    case "loop.retry_scheduled":
      return "Auto-retry scheduled";
    case "loop.manual_retry_requested":
      return "Manual retry requested";
    case "loop.decision_recorded":
      return `System decision: ${sentenceCase(
        pickString(loopDecision, ["next_action", "status"]) || "recorded"
      )}`;
    case "task.follow_up_created":
      return "Follow-up task created";
    case "task.chain_advanced":
      return "Task chain advanced";
    default:
      return sentenceCase(entry.entry_type);
  }
}

function eventDescription(
  entry: TaskHistoryEvent,
  taskLookup: Map<string, Task>,
  currentTaskId: string
) {
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const loopDecision = pickRecord(payload, ["loop_decision"]);
  const dispatchEvaluation = pickRecord(payload, ["dispatch_evaluation"]);
  const reviewerDecision = pickRecord(payload, ["reviewer_decision"]);
  const qaDecision = pickRecord(payload, ["qa_decision"]);
  const relatedTaskIds = eventRelatedTaskIds(entry, currentTaskId);

  switch (entry.entry_type) {
    case "dispatch_evaluation.recorded":
      return dispatchEvaluation?.ready_for_execution === true
        ? "The control plane marked this task ready for execution."
        : entry.summary;
    case "reviewer.decision_recorded":
      return pickStringArray(reviewerDecision, ["notes", "risky_changes"])[0] || entry.summary;
    case "qa.decision_recorded":
      return (
        pickStringArray(qaDecision, ["missing_checks", "potential_regressions", "notes"])[0] ||
        entry.summary
      );
    case "loop.retry_scheduled":
      return pickString(payload, ["reason"]) || entry.summary;
    case "loop.decision_recorded":
      return pickStringArray(loopDecision, ["reasons"])[0] || entry.summary;
    case "task.follow_up_created":
      return relatedTaskIds.length > 0
        ? `Opened ${describeTask(relatedTaskIds[0], taskLookup).label} as a follow-up task.`
        : entry.summary;
    case "task.chain_advanced":
      return relatedTaskIds.length > 0
        ? `Activated ${relatedTaskIds.length} downstream ${relatedTaskIds.length === 1 ? "task" : "tasks"} for the next loop stage.`
        : entry.summary;
    default:
      return entry.summary;
  }
}

function loopHistoryStatus(entry: TaskLoopHistoryEntry) {
  if (entry.action === "escalate_to_human") {
    return "escalated";
  }

  if (entry.action === "create_follow_up_task") {
    return "follow_up_created";
  }

  if (entry.action === "chain_next_task") {
    return "chain_ready";
  }

  if (entry.action === "mark_done") {
    return "completed";
  }

  if (entry.action === "re_execute") {
    return "retry_scheduled";
  }

  return entry.task_status || entry.result_status || entry.action;
}

function loopHistoryTitle(entry: TaskLoopHistoryEntry) {
  switch (entry.action) {
    case "re_execute":
      return "Retry loop advanced";
    case "manual_retry":
      return "Manual retry recorded";
    case "create_follow_up_task":
      return "Follow-up route selected";
    case "chain_next_task":
      return "Task chain advanced";
    case "escalate_to_human":
      return "Escalated to human";
    case "mark_done":
      return "Task marked complete";
    default:
      return `Loop transition: ${sentenceCase(entry.action)}`;
  }
}

function loopHistoryRelatedTaskIds(entry: TaskLoopHistoryEntry, currentTaskId: string) {
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const loopDecision = pickRecord(payload, ["loop_decision"]);

  return uniqueStrings([
    pickString(loopDecision, ["follow_up_task_id"]),
    ...pickStringArray(loopDecision, ["chained_task_ids"]),
    pickString(payload, ["follow_up_task_id"])
  ]).filter((taskId) => taskId !== currentTaskId);
}

function loopHistoryTone(entry: TaskLoopHistoryEntry): TimelineTone {
  if (entry.action === "escalate_to_human") {
    return "escalation";
  }

  if (entry.action === "create_follow_up_task" || entry.action === "chain_next_task") {
    return "auto";
  }

  if (entry.action === "re_execute" || entry.action === "manual_retry") {
    return "loop";
  }

  return "default";
}

function selectNumericOptions(values: number[]) {
  return Array.from(new Set(values.filter((value) => value >= 0))).sort((left, right) => left - right);
}

function selectStringOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right)
  );
}

function toneClasses(tone: TimelineTone) {
  switch (tone) {
    case "loop":
      return "border-orange-200 bg-orange-50/80";
    case "auto":
      return "border-emerald-200 bg-emerald-50/70";
    case "escalation":
      return "border-rose-200 bg-rose-50/85";
    default:
      return "border-[rgba(var(--line),0.88)] bg-white/65";
  }
}

function StatCard({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="surface-inline rounded-[24px] px-4 py-4">
      <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">{label}</p>
      <p className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-[rgb(var(--ink-strong))]">
        {value}
      </p>
      <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">{detail}</p>
    </div>
  );
}

function buildTimelineItems({
  task,
  sessions,
  runs,
  history,
  taskLookup
}: {
  task: Task;
  sessions: TaskSession[];
  runs: ExecutionRun[];
  history: TaskHistory;
  taskLookup: Map<string, Task>;
}) {
  const evaluationsByRunId = new Map<string, ResultEvaluation>();

  for (const entry of history.entries) {
    if (
      entry.entry_type !== "result_evaluation.recorded" ||
      !isRecord(entry.payload) ||
      !entry.execution_run_id
    ) {
      continue;
    }

    evaluationsByRunId.set(
      entry.execution_run_id,
      entry.payload as unknown as ResultEvaluation
    );
  }

  const loopDepth = history.loop_state?.chain_depth || 0;
  const items: TimelineItem[] = [
    {
      id: `${task.id}-created`,
      category: "Task",
      title: "Task opened",
      description: `${sentenceCase(task.task_type)} work entered the system with status ${sentenceCase(task.status)}.`,
      status: task.status,
      time: task.created_at,
      retryCount: 0,
      loopDepth,
      failureType: "none",
      relatedTaskIds: [],
      runId: null,
      tone: "default",
      isAutonomous: false,
      isEscalation: false,
      rank: 0
    }
  ];

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
      category: "Session",
      title: "Worker session started",
      description: session.artifact_path
        ? `Artifacts are being tracked at ${session.artifact_path}.`
        : "A worker session was opened for this task.",
      status: session.status,
      time: session.started_at,
      retryCount: 0,
      loopDepth,
      failureType: "none",
      relatedTaskIds: [],
      runId: null,
      tone: "default",
      isAutonomous: false,
      isEscalation: false,
      rank: 1
    });

    const sessionRuns = [...(runsBySession.get(session.id) || [])].sort((left, right) =>
      (left.started_at || left.created_at).localeCompare(right.started_at || right.created_at)
    );

    for (const run of sessionRuns) {
      const evaluation = evaluationsByRunId.get(run.id) || null;
      const failureType = deriveFailureType(run, evaluation);
      items.push({
        id: `${run.id}-run`,
        category: "Execution",
        title: `Run attempt ${run.attempt_no}`,
        description: run.error_message
          ? run.error_message
          : run.worker_name
            ? `Worker ${run.worker_name} executed attempt ${run.attempt_no}.`
            : "Execution completed without worker metadata.",
        status: run.status,
        time: run.started_at || run.created_at,
        retryCount: Math.max(run.attempt_no - 1, 0),
        loopDepth,
        failureType,
        relatedTaskIds: [],
        runId: run.id,
        tone: failureType === "none" ? "default" : "loop",
        isAutonomous: false,
        isEscalation: run.status === "escalated",
        rank: 2
      });
    }
  }

  for (const entry of [...history.loop_history].sort((left, right) =>
    left.created_at.localeCompare(right.created_at)
  )) {
    items.push({
      id: `loop-history-${entry.id}`,
      category: "Loop transition",
      title: loopHistoryTitle(entry),
      description:
        entry.summary ||
        `Loop controller recorded ${sentenceCase(entry.action)} at retry ${entry.retry_count}.`,
      status: loopHistoryStatus(entry),
      time: entry.created_at,
      retryCount: entry.retry_count,
      loopDepth: entry.chain_depth,
      failureType: entry.bug_category || entry.failure_pattern_key || "none",
      relatedTaskIds: loopHistoryRelatedTaskIds(entry, task.id),
      runId: entry.execution_run_id,
      tone: loopHistoryTone(entry),
      isAutonomous: true,
      isEscalation: entry.action === "escalate_to_human",
      rank: 3
    });
  }

  for (const entry of history.entries
    .filter((candidate) => importantEventTypes.has(candidate.entry_type))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))) {
    items.push({
      id: `${entry.entry_type}-${entry.timestamp}-${entry.execution_run_id || entry.related_task_id || entry.source}`,
      category: entry.entry_type.startsWith("task.") ? "Task link" : "System event",
      title: eventTitle(entry),
      description: eventDescription(entry, taskLookup, task.id),
      status: eventStatus(entry),
      time: entry.timestamp,
      retryCount: eventRetryCount(entry),
      loopDepth: eventLoopDepth(entry, loopDepth),
      failureType: eventFailureType(entry),
      relatedTaskIds: eventRelatedTaskIds(entry, task.id),
      runId: entry.execution_run_id,
      tone: eventTone(entry),
      isAutonomous: isAutonomousEntry(entry),
      isEscalation: isEscalationEntry(entry),
      rank: 4
    });
  }

  return items.sort((left, right) => {
    const timeComparison = (left.time || "").localeCompare(right.time || "");
    if (timeComparison !== 0) {
      return timeComparison;
    }

    return left.rank - right.rank;
  });
}

function GraphTaskCard({ node }: { node: GraphNode }) {
  return (
    <Link
      href={`/tasks/${node.taskId}`}
      className="surface-inline block rounded-[24px] border border-[rgba(var(--line),0.88)] px-4 py-4 transition hover:border-[rgba(var(--line-strong),0.95)] hover:bg-white"
    >
      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
          {sentenceCase(node.kind)}
        </p>
        <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">{node.title}</p>
        <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">{node.note}</p>
        {node.detail ? (
          <p className="text-xs leading-5 text-[rgb(var(--ink-soft))]">{node.detail}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={node.status} />
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
            {truncateId(node.taskId, 12)}
          </span>
        </div>
      </div>
    </Link>
  );
}

function GraphColumn({
  title,
  description,
  nodes,
  direction
}: {
  title: string;
  description: string;
  nodes: GraphNode[];
  direction: "incoming" | "outgoing";
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">{title}</p>
        <p className="mt-1 text-sm leading-6 text-[rgb(var(--ink-soft))]">{description}</p>
      </div>

      {nodes.length === 0 ? (
        <div className="surface-inline rounded-[24px] border border-dashed border-[rgba(var(--line),0.88)] px-4 py-4 text-sm leading-6 text-[rgb(var(--ink-soft))]">
          {direction === "incoming"
            ? "No upstream relationships were recorded for this task."
            : "No downstream tasks or follow-up links were recorded yet."}
        </div>
      ) : (
        <div className="space-y-3">
          {nodes.map((node) => (
            <div
              key={node.key}
              className={cn("relative", direction === "incoming" ? "pr-6" : "pl-6")}
            >
              <span
                className={cn(
                  "absolute top-1/2 h-px w-6 -translate-y-1/2 bg-[rgba(var(--line-strong),0.95)]",
                  direction === "incoming" ? "right-0" : "left-0"
                )}
              />
              <GraphTaskCard node={node} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskAutonomyPanel({
  task,
  planTasks,
  dependencies,
  sessions,
  runs,
  history
}: TaskAutonomyPanelProps) {
  const [view, setView] = useState<"timeline" | "graph">("timeline");
  const [retryFilter, setRetryFilter] = useState("all");
  const [failureFilter, setFailureFilter] = useState("all");
  const [depthFilter, setDepthFilter] = useState("all");

  const taskLookup = taskLookupMap(task, planTasks);
  const timelineItems = buildTimelineItems({ task, sessions, runs, history, taskLookup });
  const retryOptions = selectNumericOptions(timelineItems.map((item) => item.retryCount));
  const failureOptions = selectStringOptions(
    timelineItems
      .map((item) => item.failureType)
      .filter((failureType) => failureType !== "none")
  );
  const depthOptions = selectNumericOptions(timelineItems.map((item) => item.loopDepth));

  const filteredItems = timelineItems.filter((item) => {
    if (retryFilter !== "all" && String(item.retryCount) !== retryFilter) {
      return false;
    }

    if (failureFilter !== "all" && item.failureType !== failureFilter) {
      return false;
    }

    if (depthFilter !== "all" && String(item.loopDepth) !== depthFilter) {
      return false;
    }

    return true;
  });

  const loopState = history.loop_state;
  const failureSignals = selectStringOptions(
    timelineItems
      .map((item) => item.failureType)
      .filter((failureType) => failureType !== "none")
  );
  const escalationCount = history.entries.filter((entry) => isEscalationEntry(entry)).length;
  const decisionCount = history.entries.filter(
    (entry) => entry.entry_type === "loop.decision_recorded"
  ).length;
  const autonomousItems = filteredItems
    .filter((item) => item.isAutonomous || item.isEscalation)
    .slice()
    .sort((left, right) => (right.time || "").localeCompare(left.time || ""));

  const incomingKeys = new Set<string>();
  const outgoingKeys = new Set<string>();
  const incomingNodes: GraphNode[] = [];
  const outgoingNodes: GraphNode[] = [];

  for (const dependency of dependencies) {
    const dedupeKey = `${dependency.depends_on_task_id}-${dependency.dependency_type}`;
    if (incomingKeys.has(dedupeKey)) {
      continue;
    }

    incomingKeys.add(dedupeKey);
    const relatedTask = describeTask(dependency.depends_on_task_id, taskLookup);
    incomingNodes.push({
      key: `dependency-${dependency.id}`,
      taskId: dependency.depends_on_task_id,
      title: relatedTask.label,
      status: relatedTask.status,
      note: `Dependency gate - ${sentenceCase(dependency.dependency_type)}`,
      detail: null,
      kind: "dependency"
    });
  }

  for (const relationship of history.relationships) {
    if (relationship.child_task_id === task.id) {
      const dedupeKey = `${relationship.parent_task_id}-${relationship.relationship_type}`;
      if (!incomingKeys.has(dedupeKey)) {
        incomingKeys.add(dedupeKey);
        const relatedTask = describeTask(relationship.parent_task_id, taskLookup);
        incomingNodes.push({
          key: `incoming-${relationship.id}`,
          taskId: relationship.parent_task_id,
          title: relatedTask.label,
          status: relatedTask.status,
          note: `Parent task - ${sentenceCase(relationship.relationship_type)}`,
          detail: relationshipDetail(relationship),
          kind: "parent"
        });
      }
    }

    if (relationship.parent_task_id === task.id) {
      const dedupeKey = `${relationship.child_task_id}-${relationship.relationship_type}`;
      if (!outgoingKeys.has(dedupeKey)) {
        outgoingKeys.add(dedupeKey);
        const relatedTask = describeTask(relationship.child_task_id, taskLookup);
        outgoingNodes.push({
          key: `outgoing-${relationship.id}`,
          taskId: relationship.child_task_id,
          title: relatedTask.label,
          status: relatedTask.status,
          note:
            relationship.relationship_type === "chain"
              ? "Auto-advanced task chain"
              : "Follow-up task",
          detail: relationshipDetail(relationship),
          kind: relationship.relationship_type === "chain" ? "chain" : "follow_up"
        });
      }
    }
  }

  for (const entry of history.loop_history) {
    const relatedTaskIds = loopHistoryRelatedTaskIds(entry, task.id);
    for (const relatedTaskId of relatedTaskIds) {
      const kind = entry.action === "chain_next_task" ? "chain" : "follow_up";
      const dedupeKey = `${relatedTaskId}-${kind}`;
      if (outgoingKeys.has(dedupeKey)) {
        continue;
      }

      outgoingKeys.add(dedupeKey);
      const relatedTask = describeTask(relatedTaskId, taskLookup);
      outgoingNodes.push({
        key: `loop-history-${entry.id}-${relatedTaskId}`,
        taskId: relatedTaskId,
        title: relatedTask.label,
        status: relatedTask.status,
        note: kind === "chain" ? "Loop advanced the task chain" : "Loop created follow-up work",
        detail: entry.summary,
        kind
      });
    }
  }

  for (const entry of history.entries) {
    const relatedTaskIds = eventRelatedTaskIds(entry, task.id);
    for (const relatedTaskId of relatedTaskIds) {
      const kind = entry.entry_type === "task.chain_advanced" ? "chain" : "follow_up";
      const dedupeKey = `${relatedTaskId}-${kind}`;
      if (outgoingKeys.has(dedupeKey)) {
        continue;
      }

      outgoingKeys.add(dedupeKey);
      const relatedTask = describeTask(relatedTaskId, taskLookup);
      outgoingNodes.push({
        key: `event-${entry.entry_type}-${relatedTaskId}`,
        taskId: relatedTaskId,
        title: relatedTask.label,
        status: relatedTask.status,
        note: kind === "chain" ? "Activated downstream task" : "Auto-created follow-up",
        detail: entry.summary,
        kind
      });
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
            Loop state
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={loopState?.status || task.status} />
            {loopState?.current_action ? <StatusBadge status={loopState.current_action} /> : null}
          </div>
          <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
            Track retries, system decisions, follow-up creation, dependency activation, and escalation points for this task.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setView("timeline")}
            className={cn(
              "inline-flex rounded-full border px-4 py-2 text-sm font-medium transition",
              view === "timeline"
                ? "border-[rgb(var(--accent))] bg-[rgba(var(--accent-soft),0.9)] text-[rgb(var(--accent))]"
                : "border-[rgb(var(--line))] text-[rgb(var(--ink-strong))] hover:border-[rgb(var(--line-strong))] hover:bg-white"
            )}
          >
            Timeline view
          </button>
          <button
            type="button"
            onClick={() => setView("graph")}
            className={cn(
              "inline-flex rounded-full border px-4 py-2 text-sm font-medium transition",
              view === "graph"
                ? "border-[rgb(var(--accent))] bg-[rgba(var(--accent-soft),0.9)] text-[rgb(var(--accent))]"
                : "border-[rgb(var(--line))] text-[rgb(var(--ink-strong))] hover:border-[rgb(var(--line-strong))] hover:bg-white"
            )}
          >
            Graph view
          </button>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[repeat(3,minmax(0,1fr))]">
        <label className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
            Retry count
          </p>
          <select
            value={retryFilter}
            onChange={(event) => setRetryFilter(event.target.value)}
            className="mt-3 w-full border-0 bg-transparent text-sm font-semibold text-[rgb(var(--ink-strong))] outline-none"
          >
            <option value="all">All retry counts</option>
            {retryOptions.map((retryCount) => (
              <option key={retryCount} value={String(retryCount)}>
                {retryCount} {retryCount === 1 ? "retry" : "retries"}
              </option>
            ))}
          </select>
        </label>

        <label className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
            Failure type
          </p>
          <select
            value={failureFilter}
            onChange={(event) => setFailureFilter(event.target.value)}
            className="mt-3 w-full border-0 bg-transparent text-sm font-semibold text-[rgb(var(--ink-strong))] outline-none"
          >
            <option value="all">All failure types</option>
            {failureOptions.map((failureType) => (
              <option key={failureType} value={failureType}>
                {sentenceCase(failureType)}
              </option>
            ))}
          </select>
        </label>

        <label className="surface-inline rounded-[24px] px-4 py-4">
          <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
            Loop depth
          </p>
          <select
            value={depthFilter}
            onChange={(event) => setDepthFilter(event.target.value)}
            className="mt-3 w-full border-0 bg-transparent text-sm font-semibold text-[rgb(var(--ink-strong))] outline-none"
          >
            <option value="all">All loop depths</option>
            {depthOptions.map((depth) => (
              <option key={depth} value={String(depth)}>
                Depth {depth}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Retry count"
          value={String(loopState?.retry_count || 0)}
          detail={`The loop has consumed ${loopState?.retry_count || 0} retry ${loopState?.retry_count === 1 ? "slot" : "slots"} so far.`}
        />
        <StatCard
          label="Loop depth"
          value={String(loopState?.chain_depth || 0)}
          detail="Higher depths indicate longer autonomous task chains."
        />
        <StatCard
          label="Failure signals"
          value={String(failureSignals.length)}
          detail={
            failureSignals.length === 0
              ? "No failure categories were detected."
              : failureSignals.map((signal) => sentenceCase(signal)).join(", ")
          }
        />
        <StatCard
          label="Escalation points"
          value={String(escalationCount)}
          detail={
            escalationCount === 0
              ? "No escalation events were recorded."
              : "Escalations are highlighted in rose across the views."
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
        <span className="rounded-full border border-[rgba(var(--line),0.9)] bg-white px-3 py-1">
          Execution attempts
        </span>
        <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-orange-800">
          Loop transitions
        </span>
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-800">
          Autonomous actions
        </span>
        <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-rose-800">
          Escalation points
        </span>
        {history.loop_history.length > 0 ? (
          <span className="rounded-full border border-[rgba(var(--line),0.9)] bg-white px-3 py-1">
            {history.loop_history.length} recorded loop transitions
          </span>
        ) : null}
      </div>

      {view === "timeline" ? (
        filteredItems.length === 0 ? (
          <EmptyState
            title="No timeline entries match the current filters"
            body="Adjust retry count, failure type, or loop depth to widen the execution history."
          />
        ) : (
          <ol className="space-y-4">
            {filteredItems.map((item, index) => (
              <li key={item.id} className="relative pl-9">
                {index < filteredItems.length - 1 ? (
                  <span className="absolute left-[13px] top-7 h-[calc(100%+1rem)] w-px bg-[rgba(var(--line),0.95)]" />
                ) : null}
                <span
                  className={cn(
                    "absolute left-0 top-2 h-7 w-7 rounded-full border",
                    item.tone === "escalation"
                      ? "border-rose-300 bg-rose-100"
                      : item.tone === "loop"
                        ? "border-orange-300 bg-orange-100"
                        : item.tone === "auto"
                          ? "border-emerald-300 bg-emerald-100"
                          : "border-[rgba(var(--line-strong),0.92)] bg-white"
                  )}
                />

                <div className={cn("rounded-[26px] border px-4 py-4", toneClasses(item.tone))}>
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[11px] uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                          {item.category}
                        </p>
                        {item.isAutonomous ? (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-800">
                            Autonomous
                          </span>
                        ) : null}
                        {item.isEscalation ? (
                          <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-800">
                            Escalation point
                          </span>
                        ) : null}
                      </div>

                      <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                        {item.title}
                      </p>
                      <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                        {item.description}
                      </p>

                      <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                        <span>Retry {item.retryCount}</span>
                        <span>Depth {item.loopDepth}</span>
                        {item.failureType !== "none" ? (
                          <span>{sentenceCase(item.failureType)}</span>
                        ) : null}
                        {item.runId ? <span>Run {truncateId(item.runId, 12)}</span> : null}
                      </div>

                      {item.relatedTaskIds.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-2">
                          {item.relatedTaskIds.map((relatedTaskId) => {
                            const relatedTask = describeTask(relatedTaskId, taskLookup);
                            return (
                              <Link
                                key={`${item.id}-${relatedTaskId}`}
                                href={`/tasks/${relatedTaskId}`}
                                className="inline-flex rounded-full border border-[rgba(var(--line),0.95)] bg-white px-3 py-1 text-xs font-medium text-[rgb(var(--ink-strong))] transition hover:border-[rgba(var(--line-strong),0.95)]"
                              >
                                {relatedTask.label}
                              </Link>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                      <StatusBadge status={item.status} />
                      <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                        {formatDateTime(item.time)}
                      </span>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )
      ) : (
        <div className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,280px)_minmax(0,1fr)_minmax(0,280px)]">
            <GraphColumn
              title="Incoming"
              description="Parent tasks and blockers feeding into this task."
              nodes={incomingNodes}
              direction="incoming"
            />

            <div className="relative">
              <span className="absolute left-1/2 top-0 hidden h-full w-px -translate-x-1/2 bg-[rgba(var(--line),0.9)] xl:block" />
              <div className="surface-inline relative rounded-[30px] border border-[rgba(var(--line-strong),0.92)] bg-white/85 px-5 py-5">
                {(loopState?.retry_count || 0) > 0 ? (
                  <span className="pointer-events-none absolute inset-2 rounded-[24px] border border-dashed border-orange-300" />
                ) : null}

                <div className="relative space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-2">
                      <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                        Current task
                      </p>
                      <p className="text-xl font-semibold tracking-[-0.03em] text-[rgb(var(--ink-strong))]">
                        {task.title}
                      </p>
                      <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                        The central node exposes loop status, retry pressure, and the most recent autonomous decision.
                      </p>
                    </div>

                    <StatusBadge status={loopState?.status || task.status} />
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-[24px] border border-[rgba(var(--line),0.88)] px-4 py-4">
                      <p className="text-[11px] uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                        Retry loop
                      </p>
                      <p className="mt-2 text-2xl font-semibold text-[rgb(var(--ink-strong))]">
                        {loopState?.retry_count || 0}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                        Current action: {sentenceCase(loopState?.current_action || "idle")}
                      </p>
                    </div>

                    <div className="rounded-[24px] border border-[rgba(var(--line),0.88)] px-4 py-4">
                      <p className="text-[11px] uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                        Chain depth
                      </p>
                      <p className="mt-2 text-2xl font-semibold text-[rgb(var(--ink-strong))]">
                        {loopState?.chain_depth || 0}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                        Follow-up tasks created: {loopState?.follow_up_count || 0}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {typeof loopState?.consecutive_failures === "number" ? (
                      <span className="rounded-full border border-[rgba(var(--line),0.95)] bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                        Consecutive failures {loopState.consecutive_failures}
                      </span>
                    ) : null}
                    {loopState?.last_result_status ? (
                      <span className="rounded-full border border-[rgba(var(--line),0.95)] bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                        Result {sentenceCase(loopState.last_result_status)}
                      </span>
                    ) : null}
                    {loopState?.last_bug_category ? (
                      <span className="rounded-full border border-[rgba(var(--line),0.95)] bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                        {sentenceCase(loopState.last_bug_category)}
                      </span>
                    ) : null}
                    {loopState?.last_failure_pattern ? (
                      <span className="rounded-full border border-[rgba(var(--line),0.95)] bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                        Pattern {sentenceCase(loopState.last_failure_pattern)}
                      </span>
                    ) : null}
                    {loopState?.follow_up_count ? (
                      <span className="rounded-full border border-[rgba(var(--line),0.95)] bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                        Follow-ups {loopState.follow_up_count}
                      </span>
                    ) : null}
                  </div>

                  {escalationCount > 0 ? (
                    <div className="rounded-[24px] border border-rose-200 bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-900">
                      Escalation points have been recorded for this task. Inspect the timeline to see the exact transition that pushed the loop to a human handoff.
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <GraphColumn
              title="Outgoing"
              description="Follow-ups, chain tasks, and downstream work activated by this task."
              nodes={outgoingNodes}
              direction="outgoing"
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="surface-inline rounded-[26px] px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                    Autonomous actions
                  </p>
                  <p className="mt-1 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                    Retries, chain advances, and follow-up creation captured by the control plane.
                  </p>
                </div>
                <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                  {autonomousItems.length} visible
                </p>
              </div>

              {autonomousItems.length === 0 ? (
                <p className="mt-4 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                  No autonomous actions matched the current filters.
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  {autonomousItems.slice(0, 6).map((item) => (
                    <div
                      key={`action-${item.id}`}
                      className="rounded-[22px] border border-[rgba(var(--line),0.88)] bg-white/70 px-4 py-4"
                    >
                      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                            {item.title}
                          </p>
                          <p className="text-sm leading-6 text-[rgb(var(--ink-soft))]">
                            {item.description}
                          </p>
                        </div>
                        <span className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--ink-soft))]">
                          {formatDateTime(item.time)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="surface-inline rounded-[26px] px-4 py-4">
              <p className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">
                Loop decisions
              </p>
              <div className="mt-4 space-y-3">
                <div className="rounded-[22px] border border-[rgba(var(--line),0.88)] bg-white/70 px-4 py-4">
                  <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                    System decisions
                  </p>
                  <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-[rgb(var(--ink-strong))]">
                    {decisionCount}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                    Loop controller decisions recorded for this task.
                  </p>
                </div>

                <div className="rounded-[22px] border border-[rgba(var(--line),0.88)] bg-white/70 px-4 py-4">
                  <p className="text-sm font-semibold text-[rgb(var(--ink-strong))]">
                    Latest transition
                  </p>
                  <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                    {formatDateTime(loopState?.last_transition_at || task.updated_at)}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-[rgb(var(--ink-soft))]">
                    Last action: {sentenceCase(loopState?.current_action || "idle")}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
