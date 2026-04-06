import unittest

from sqlmodel import Session, SQLModel, create_engine

from app.models import ExecutionRun, Plan, Project, Task, TaskSession
from app.services.result_evaluator import evaluate_run_result


class Phase3LoopControllerTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(self.engine)
        self.session = Session(self.engine)
        self.project = Project(name="Phase 3", description="loop controller test")
        self.session.add(self.project)
        self.session.commit()
        self.session.refresh(self.project)

    def tearDown(self):
        self.session.close()

    def _create_task(self, *, task_type="generic", title="Implement loop controller") -> Task:
        plan = Plan(
            project_id=self.project.id,
            version=1,
            title="Approved plan",
            summary="Test plan",
            status="approved",
        )
        self.session.add(plan)
        self.session.commit()
        self.session.refresh(plan)

        task = Task(
            plan_id=plan.id,
            position=1,
            task_type=task_type,
            title=title,
            instructions=(
                "Only modify apps/control-plane-python/app/services and preserve existing contracts "
                "while delivering validation evidence for the requested task."
            ),
            status="approved",
            input_payload={
                "acceptance_criteria": [
                    "update control plane logic",
                    "add validation evidence",
                ],
                "constraints": [
                    "Only modify apps/control-plane-python/app/services",
                ],
            },
        )
        self.session.add(task)
        self.session.commit()
        self.session.refresh(task)
        return task

    def _create_run(
        self,
        task: Task,
        *,
        status: str,
        output_payload: dict,
        error_message: str | None = None,
    ) -> ExecutionRun:
        task_session = TaskSession(
            task_id=task.id,
            status="open",
            session_metadata={"channel": "test"},
        )
        self.session.add(task_session)
        self.session.commit()
        self.session.refresh(task_session)

        run = ExecutionRun(
            task_session_id=task_session.id,
            attempt_no=1,
            status=status,
            input_payload={"task_id": str(task.id)},
            output_payload=output_payload,
            error_message=error_message,
        )
        self.session.add(run)
        self.session.commit()
        self.session.refresh(run)
        return run

    def test_successful_run_chains_next_task(self):
        task = self._create_task()
        run = self._create_run(
            task,
            status="completed",
            output_payload={
                "summary": "updated control plane logic with validation evidence and tests",
                "changed_files": ["apps/control-plane-python/app/services/loop_worker.py"],
                "tests": ["validation evidence"],
            },
        )

        evaluation = evaluate_run_result(self.session, run.id)

        self.assertEqual(evaluation.status, "passed")
        self.assertIsNotNone(evaluation.loop_decision)
        self.assertEqual(evaluation.loop_decision.next_action, "chain_next_task")
        self.assertGreaterEqual(len(evaluation.loop_decision.chained_task_ids), 1)

    def test_blocked_run_schedules_retry(self):
        task = self._create_task(title="Implement retry flow")
        run = self._create_run(
            task,
            status="blocked",
            output_payload={
                "summary": "dependency fetch blocked during execution",
                "changed_files": ["apps/control-plane-python/app/services/retry_worker.py"],
            },
            error_message="network timeout while contacting dependency service",
        )

        evaluation = evaluate_run_result(self.session, run.id)

        self.assertEqual(evaluation.status, "blocked")
        self.assertIsNotNone(evaluation.loop_decision)
        self.assertEqual(evaluation.loop_decision.next_action, "re_execute")
        self.assertEqual(evaluation.loop_decision.retry_count, 1)

    def test_failed_run_creates_follow_up_task(self):
        task = self._create_task(title="Implement bug fix")
        run = self._create_run(
            task,
            status="failed",
            output_payload={
                "summary": "service logic remains broken after update",
                "changed_files": ["apps/control-plane-python/app/services/fix_worker.py"],
            },
            error_message="implementation bug left required logic incomplete",
        )

        evaluation = evaluate_run_result(self.session, run.id)

        self.assertEqual(evaluation.status, "needs_rework")
        self.assertIsNotNone(evaluation.loop_decision)
        self.assertEqual(evaluation.loop_decision.next_action, "create_follow_up_task")
        self.assertIsNotNone(evaluation.loop_decision.follow_up_task_id)


if __name__ == "__main__":
    unittest.main()
