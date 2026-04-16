import { AutonomyOpsBoard } from "@/components/autonomy-ops-board";
import { PageHeader } from "@/components/page-header";
import { ResourceNotice } from "@/components/resource-notice";
import { SectionPanel } from "@/components/section-panel";
import { buildProjectAutonomySummary, buildTaskAutonomySnapshot } from "@/lib/autonomy";
import {
  emptyResource,
  getTaskHistory,
  getTaskMemory,
  listPlanTasks,
  listProjectPlans,
  listProjects
} from "@/lib/api/control-plane";

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
          latestPlan,
          tasks: emptyResource([], `/plans/${project.id}/tasks`),
          taskHistories: [],
          taskMemories: []
        };
      }

      const tasks = await listPlanTasks(latestPlan.id);
      const [taskHistories, taskMemories] = await Promise.all([
        Promise.all(tasks.data.map((task) => getTaskHistory(task.id))),
        Promise.all(tasks.data.map((task) => getTaskMemory(task.id)))
      ]);

      return {
        project,
        plans,
        latestPlan,
        tasks,
        taskHistories,
        taskMemories
      };
    })
  );

  const projectSummaries = projectBundles.map((bundle) =>
    buildProjectAutonomySummary({
      projectId: bundle.project.id,
      projectName: bundle.project.name,
      tasks: bundle.tasks.data,
      snapshots: bundle.tasks.data.map((task, index) =>
        buildTaskAutonomySnapshot(
          task,
          bundle.taskHistories[index]?.data || {
            task_id: task.id,
            loop_state: null,
            relationships: [],
            loop_history: [],
            entries: []
          },
          bundle.taskMemories[index]?.data || null
        )
      )
    })
  );

  const resources = [
    projects,
    ...projectBundles.flatMap((bundle) => [bundle.plans, bundle.tasks, ...bundle.taskHistories, ...bundle.taskMemories])
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Phase 4 operator view"
        title="Selective autonomy"
        description="Monitor confidence, approval queues, policy blocks, human escalations, and project-level autonomy posture from one control surface."
      />

      <ResourceNotice resources={resources} />

      <SectionPanel
        title="Production readiness"
        description="Cross-project autonomy queues and summaries tuned for operator trust, intervention, and selective automation."
      >
        <AutonomyOpsBoard projects={projectSummaries} />
      </SectionPanel>
    </div>
  );
}
