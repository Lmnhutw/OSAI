import unittest

from sqlmodel import Session, SQLModel, create_engine, select

from app.ai_models import AutonomyDecision, ExecutionContract
from app.api.tasks import approve_tasks_batch
from app.models import Plan, Project, Task
from app.schemas import AutonomyOverrideCreate, BatchTaskApprove
from app.services.autonomy_service import (
    apply_task_autonomy_override,
    get_project_autonomy_summary,
    get_task_autonomy,
)
from app.services.dispatch_evaluator import evaluate_task_dispatch


class Phase4AutonomyTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(self.engine)
        self.session = Session(self.engine)
        self.project = Project(name="Phase 4", description="autonomy test")
        self.session.add(self.project)
        self.session.commit()
        self.session.refresh(self.project)

        self.plan = Plan(
            project_id=self.project.id,
            version=1,
            title="Approved plan",
            summary="Phase 4 plan",
            status="approved",
        )
        self.session.add(self.plan)
        self.session.commit()
        self.session.refresh(self.plan)

    def tearDown(self):
        self.session.close()

    def _create_task(
        self,
        *,
        title: str,
        instructions: str,
        task_type: str = "generic",
        input_payload: dict | None = None,
    ) -> Task:
        task = Task(
            plan_id=self.plan.id,
            position=1,
            task_type=task_type,
            title=title,
            instructions=instructions,
            status="approved",
            input_payload=input_payload
            or {
                "acceptance_criteria": ["deliver the requested change", "capture validation evidence"],
                "constraints": ["Only modify apps/control-plane-python/app/services"],
            },
        )
        self.session.add(task)
        self.session.commit()
        self.session.refresh(task)
        return task

    def test_low_risk_test_only_dispatch_auto_executes(self):
        task = self._create_task(
            title="Add regression tests for loop controller",
            instructions=(
                "Only add regression tests under apps/control-plane-python/tests and capture validation evidence "
                "for the loop controller behavior."
            ),
            input_payload={
                "acceptance_criteria": ["add regression tests", "capture validation evidence"],
                "constraints": ["Only modify apps/control-plane-python/tests"],
            },
        )

        evaluation = evaluate_task_dispatch(self.session, task.id)

        self.assertTrue(evaluation.policy_decision.allow_auto_execute)
        self.assertEqual(evaluation.policy_decision.autonomy_mode, "auto_execute")
        decision = self.session.exec(select(AutonomyDecision).where(AutonomyDecision.task_id == task.id)).one()
        contract = self.session.exec(select(ExecutionContract).where(ExecutionContract.task_id == task.id)).one()
        self.assertEqual(decision.autonomy_mode, "auto_execute")
        self.assertEqual(contract.autonomy_decision_id, decision.id)
        self.assertEqual(contract.approval_state, "not_required")
        self.assertEqual(task.input_payload["execution_contract"]["id"], str(contract.id))
        autonomy = get_task_autonomy(self.session, task.id)
        self.assertEqual(autonomy.policy_decision.task_classification, "test_only")

    def test_schema_sensitive_dispatch_requires_approval(self):
        task = self._create_task(
            title="Add schema migration for task memory",
            task_type="migration",
            instructions=(
                "Create a database migration that adds schema changes for task memory persistence and preserve "
                "backward compatibility."
            ),
            input_payload={
                "acceptance_criteria": ["create the schema migration", "preserve backward compatibility"],
                "constraints": ["Only modify db/migrations and apps/control-plane-python/app/models.py"],
            },
        )

        evaluation = evaluate_task_dispatch(self.session, task.id)

        self.assertEqual(evaluation.policy_decision.task_classification, "schema_sensitive")
        self.assertEqual(evaluation.policy_decision.autonomy_mode, "approval_required")
        self.assertTrue(evaluation.policy_decision.require_approval)

    def test_operator_task_approval_issues_a_new_authoritative_contract(self):
        task = self._create_task(
            title="Add test coverage",
            instructions="Only add tests and validation evidence under apps/control-plane-python/tests.",
            input_payload={
                "acceptance_criteria": ["add tests", "capture validation evidence"],
                "constraints": ["Only modify apps/control-plane-python/tests"],
            },
        )

        approved = approve_tasks_batch(
            BatchTaskApprove(task_ids=[task.id]),
            actor="operator@example.com",
            session=self.session,
        )

        self.assertEqual(approved[0].status, "approved")
        contracts = self.session.exec(
            select(ExecutionContract)
            .where(ExecutionContract.task_id == task.id)
            .order_by(ExecutionContract.issued_at.desc())
        ).all()
        self.assertEqual(contracts[0].approval_state, "approved")
        self.assertEqual(contracts[0].execution_mode, "execute_with_validation")

    def test_override_can_force_review_and_disable_retries(self):
        task = self._create_task(
            title="Implement low-risk task",
            instructions=(
                "Only modify apps/control-plane-python/app/services for a localized implementation change and "
                "capture validation evidence."
            ),
        )
        apply_task_autonomy_override(
            self.session,
            task.id,
            AutonomyOverrideCreate(
                operator="operator@example.com",
                reason="Keep this task under manual review while we monitor Phase 4 rollout.",
                force_review=True,
                disable_retries=True,
            ),
        )

        evaluation = evaluate_task_dispatch(self.session, task.id)
        autonomy = get_task_autonomy(self.session, task.id)

        self.assertEqual(evaluation.policy_decision.autonomy_mode, "review_required")
        self.assertTrue(evaluation.policy_decision.override_applied)
        self.assertFalse(evaluation.policy_decision.retry_allowed)
        self.assertEqual(len(autonomy.active_overrides), 1)
        self.assertTrue(autonomy.policy_decision.review_required)

    def test_project_autonomy_summary_aggregates_latest_modes(self):
        auto_task = self._create_task(
            title="Add test coverage",
            instructions="Only add tests and validation evidence under apps/control-plane-python/tests.",
            input_payload={
                "acceptance_criteria": ["add tests", "capture validation evidence"],
                "constraints": ["Only modify apps/control-plane-python/tests"],
            },
        )
        approval_task = self._create_task(
            title="Update authentication policy",
            instructions=(
                "Update authentication policy enforcement and preserve production behavior for existing sessions."
            ),
            input_payload={
                "acceptance_criteria": ["update authentication policy", "preserve production behavior"],
                "constraints": ["Only modify apps/control-plane-python/app/services/policy_engine.py"],
            },
        )

        evaluate_task_dispatch(self.session, auto_task.id)
        evaluate_task_dispatch(self.session, approval_task.id)
        summary = get_project_autonomy_summary(self.session, self.project.id)

        self.assertEqual(summary.total_tasks, 2)
        self.assertEqual(summary.evaluated_tasks, 2)
        self.assertGreaterEqual(summary.mode_counts.get("auto_execute", 0), 1)
        self.assertGreaterEqual(summary.mode_counts.get("approval_required", 0), 1)


if __name__ == "__main__":
    unittest.main()
