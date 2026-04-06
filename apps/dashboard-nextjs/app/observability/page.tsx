import { ObservabilityBoard, type ObservabilityItem } from "@/components/observability-board";
import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { SectionPanel } from "@/components/section-panel";
import {
  emptyResource,
  listPlanTasks,
  listProjectPlans,
  listProjects,
  listRunEvents,
  listTaskRuns
} from "@/lib/api/control-plane";
import {
  deriveDispatchStatus,
  deriveFailureType,
  deriveRiskLevel,
  extractChangedFiles,
  getQADecision,
  getResultEvaluation,
  getReviewerDecision
} from "@/lib/intelligence";

export const dynamic = "force-dynamic";

export default async function ObservabilityPage() {
  const projects = await listProjects();

  const projectBundles = await Promise.all(
    projects.data.map(async (project) => {
      const plans = await listProjectPlans(project.id);
      const latestPlan = [...plans.data].sort((left, right) => right.version - left.version)[0] ?? null;

      if (!latestPlan) {
        return {
          project,
          plans,
          tasks: emptyResource([], `/plans/${project.id}/tasks`),
          taskBundles: []
        };
      }

      const tasks = await listPlanTasks(latestPlan.id);
      const taskBundles = await Promise.all(
        tasks.data.map(async (task) => {
          const runs = await listTaskRuns(task.id);
          const latestRun =
            [...runs.data].sort((left, right) =>
              (right.started_at || right.created_at).localeCompare(left.started_at || left.created_at)
            )[0] ?? null;
          const latestRunEvents = latestRun
            ? await listRunEvents(latestRun.id)
            : emptyResource([], `/runs/${task.id}/events`);
          const resultEvaluation = getResultEvaluation(latestRunEvents.data);
          const reviewerDecision =
            getReviewerDecision(latestRunEvents.data) || resultEvaluation?.reviewer_decision || null;
          const qaDecision =
            getQADecision(latestRunEvents.data) || resultEvaluation?.qa_decision || null;

          return {
            task,
            runs,
            latestRun,
            latestRunEvents,
            resultEvaluation,
            reviewerDecision,
            qaDecision
          };
        })
      );

      return {
        project,
        plans,
        latestPlan,
        tasks,
        taskBundles
      };
    })
  );

  const boardItems: ObservabilityItem[] = projectBundles.flatMap((bundle) =>
    bundle.taskBundles.map((taskBundle) => ({
      projectId: bundle.project.id,
      projectName: bundle.project.name,
      planId: bundle.latestPlan?.id || "",
      planVersion: bundle.latestPlan?.version || 0,
      taskId: taskBundle.task.id,
      title: taskBundle.task.title,
      taskType: taskBundle.task.task_type,
      status: taskBundle.task.status,
      riskLevel: deriveRiskLevel(null, taskBundle.resultEvaluation, taskBundle.latestRun),
      failureType: deriveFailureType(taskBundle.latestRun, taskBundle.resultEvaluation),
      dispatchStatus: deriveDispatchStatus(taskBundle.task, null),
      reviewStatus: taskBundle.reviewerDecision?.status || null,
      qaStatus: taskBundle.qaDecision?.status || null,
      latestRunId: taskBundle.latestRun?.id || null,
      latestRunStatus: taskBundle.latestRun?.status || null,
      changedFilesCount: taskBundle.latestRun
        ? extractChangedFiles(taskBundle.latestRun.output_payload).length
        : 0,
      updatedAt: taskBundle.task.updated_at,
      latestActivityAt:
        taskBundle.latestRun?.finished_at ||
        taskBundle.latestRun?.started_at ||
        taskBundle.latestRun?.created_at ||
        taskBundle.task.updated_at,
      errorSummary:
        taskBundle.latestRun?.error_message ||
        taskBundle.reviewerDecision?.risky_changes[0] ||
        taskBundle.qaDecision?.missing_checks[0] ||
        null
    }))
  );

  const resources = [
    projects,
    ...projectBundles.flatMap((bundle) => [
      bundle.plans,
      bundle.tasks,
      ...bundle.taskBundles.flatMap((taskBundle) => [taskBundle.runs, taskBundle.latestRunEvents])
    ])
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Phase 2 observability"
        title="Execution intelligence"
        description="Filter the active task surface by status, risk, project, and failure type while scanning review, QA, and retry signals."
      />

      <ResourceNotice resources={resources} />

      <SectionPanel
        title="Decision support board"
        description="Cross-project task monitoring tuned for operator triage instead of raw registry browsing."
      >
        <ObservabilityBoard items={boardItems} />
      </SectionPanel>
    </div>
  );
}
