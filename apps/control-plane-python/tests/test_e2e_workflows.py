"""API-level workflow tests for the operator control plane.

These use a file-backed SQLite database only as a hermetic test transport. The
production schema is exercised separately through PostgreSQL migrations.
"""

from __future__ import annotations

import os
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine

from app.ai_runtime import ModelCallMetadata, ModelRuntime
from app.database import get_session
from app.models import ExecutionRun, Task, TaskSession
from main import app


class ControlPlaneWorkflowE2ETests(unittest.TestCase):
    def setUp(self):
        handle = tempfile.NamedTemporaryFile(prefix="osai-e2e-", suffix=".db", delete=False)
        handle.close()
        self.database_path = handle.name
        self.engine = create_engine(f"sqlite:///{self.database_path}", connect_args={"check_same_thread": False})
        SQLModel.metadata.create_all(self.engine)

        def override_session():
            with Session(self.engine) as session:
                yield session

        app.dependency_overrides[get_session] = override_session
        self.environment = patch.dict(
            os.environ,
            {
                "OSAI_ENV": "test",
                "OSAI_REASONING_PROVIDER": "test",
                "OSAI_REASONING_MODEL": "fixture-reasoning",
                "OSAI_EXECUTION_PROVIDER": "test",
                "OSAI_EXECUTION_MODEL": "fixture-execution",
                "OSAI_REVIEW_PROVIDER": "test",
                "OSAI_REVIEW_MODEL": "fixture-review",
                "OSAI_JIRA_ENABLED": "false",
            },
            clear=False,
        )
        self.environment.start()
        self.runtime = patch.object(ModelRuntime, "invoke_json", autospec=True, side_effect=self._fixture_model)
        self.runtime.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.runtime.stop()
        self.environment.stop()
        app.dependency_overrides.clear()
        self.engine.dispose()
        os.unlink(self.database_path)

    @staticmethod
    def _fixture_model(_runtime, profile, *, response_model, **_kwargs):
        if response_model.__name__ == "GeneratedPlan":
            result = response_model(
                title="E2E controlled delivery",
                summary="A plan generated through the configured reasoning profile for API workflow verification.",
            )
        elif response_model.__name__ == "GeneratedTaskList":
            result = response_model(
                tasks=[
                    {
                        "title": "Add isolated control-plane regression coverage",
                        "instructions": "Only add regression tests under apps/control-plane-python/tests and capture validation evidence.",
                        "task_type": "test",
                        "input_payload": {
                            "acceptance_criteria": ["regression test", "validation evidence"],
                            "constraints": ["Only modify apps/control-plane-python/tests"],
                        },
                    }
                ]
            )
        else:  # pragma: no cover - protects the test fixture from unannounced agents.
            raise AssertionError(f"Unexpected response model: {response_model.__name__}")
        return result, ModelCallMetadata(
            profile=profile,
            provider="test",
            model=f"fixture-{profile}",
            provider_request_id=f"e2e-{response_model.__name__}",
            input_tokens=10,
            output_tokens=10,
            latency_ms=1,
        )

    def _create_approved_task(self) -> tuple[dict, dict, dict]:
        project_response = self.client.post(
            "/projects",
            json={"name": "E2E project", "description": "Operator workflow verification"},
        )
        self.assertEqual(project_response.status_code, 201, project_response.text)
        project = project_response.json()
        requirement_response = self.client.post(
            f"/projects/{project['id']}/requirements",
            json=[{"position": 1, "requirement_text": "Use three configured model profiles with operator approval."}],
        )
        self.assertEqual(requirement_response.status_code, 200, requirement_response.text)

        plan_response = self.client.post(
            f"/projects/{project['id']}/plan/generate",
            headers={"X-OSAI-Actor": "planner-operator@example.com"},
        )
        self.assertEqual(plan_response.status_code, 200, plan_response.text)
        plan = plan_response.json()
        approval = self.client.get(f"/plans/{plan['id']}/approvals").json()[0]
        decision_response = self.client.post(
            f"/approvals/{approval['id']}/decision",
            headers={"X-OSAI-Actor": "approver@example.com"},
            json={
                "decision": "approved",
                "decision_note": "Approved in API E2E workflow.",
                "expected_plan_updated_at": plan["updated_at"],
                "idempotency_key": f"e2e-approval-{uuid.uuid4()}",
            },
        )
        self.assertEqual(decision_response.status_code, 200, decision_response.text)
        task_response = self.client.post(
            f"/plans/{plan['id']}/tasks/generate",
            headers={"X-OSAI-Actor": "pm-operator@example.com"},
        )
        self.assertEqual(task_response.status_code, 200, task_response.text)
        task = task_response.json()[0]
        return project, plan, task

    def _add_failed_run(self, task_id: str) -> dict:
        with Session(self.engine) as session:
            task = session.get(Task, uuid.UUID(task_id))
            assert task is not None
            task.status = "approved"
            task_session = TaskSession(task_id=task.id, status="failed")
            session.add(task_session)
            session.commit()
            session.refresh(task_session)
            run = ExecutionRun(
                task_session_id=task_session.id,
                attempt_no=1,
                status="failed",
                worker_name="e2e-worker",
                error_message="fixture execution failure",
                input_payload=task.input_payload,
                output_payload={"changed_files": [], "validation": "failed fixture"},
                started_at=datetime.now(timezone.utc),
                finished_at=datetime.now(timezone.utc),
            )
            session.add(run)
            session.commit()
            session.refresh(run)
            return {"id": str(run.id), "session_id": str(task_session.id)}

    def test_e2e_create_project_requirements_plan_and_approval(self):
        project, plan, task = self._create_approved_task()
        self.assertEqual(plan["status"], "draft")
        self.assertEqual(task["status"], "pending")
        self.assertEqual(project["name"], "E2E project")
        self.assertEqual(self.client.get(f"/plans/{plan['id']}").json()["status"], "approved")
        filtered_plans = self.client.get("/plans?status=approved&sort_by=version&sort_direction=asc&limit=10")
        self.assertEqual(filtered_plans.status_code, 200, filtered_plans.text)
        self.assertIn(plan["id"], [item["id"] for item in filtered_plans.json()])
        overview = self.client.get(f"/operator/projects/{project['id']}/overview")
        self.assertEqual(overview.status_code, 200, overview.text)
        self.assertEqual(overview.json()["latest_plan"]["id"], plan["id"])

    def test_e2e_task_dispatch_evaluation(self):
        _project, _plan, task = self._create_approved_task()
        response = self.client.post(f"/tasks/{task['id']}/evaluate-dispatch")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn(response.json()["status"], {"ready_for_dispatch", "awaiting_review", "awaiting_approval"})
        workbench = self.client.get(f"/operator/tasks/{task['id']}/workbench")
        self.assertEqual(workbench.status_code, 200, workbench.text)
        self.assertEqual(workbench.json()["task"]["id"], task["id"])

    def test_e2e_execution_result_evaluation(self):
        _project, _plan, task = self._create_approved_task()
        run = self._add_failed_run(task["id"])
        response = self.client.post(f"/runs/{run['id']}/evaluate-result")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["run_id"], run["id"])
        self.assertIn(response.json()["status"], {"needs_rework", "awaiting_review", "qa_pending", "blocked"})
        inspection = self.client.get(f"/operator/runs/{run['id']}/inspection")
        self.assertEqual(inspection.status_code, 200, inspection.text)
        self.assertEqual(inspection.json()["run"]["id"], run["id"])
        filtered_runs = self.client.get("/runs?status=failed&sort_by=attempt_no&sort_direction=asc&limit=10")
        self.assertEqual(filtered_runs.status_code, 200, filtered_runs.text)
        self.assertIn(run["id"], [item["id"] for item in filtered_runs.json()])

    def test_e2e_retry_follow_up_and_escalation_path(self):
        _project, _plan, task = self._create_approved_task()
        run = self._add_failed_run(task["id"])
        evaluation = self.client.post(f"/runs/{run['id']}/evaluate-result")
        self.assertEqual(evaluation.status_code, 200, evaluation.text)
        retry = self.client.post(
            f"/tasks/{task['id']}/retry",
            headers={"X-OSAI-Actor": "operator@example.com"},
            json={"run_id": run["id"], "reason": "Retry from E2E operator workflow"},
        )
        self.assertIn(retry.status_code, {200, 400}, retry.text)
        follow_up = self.client.post(
            f"/tasks/{task['id']}/follow-up",
            headers={"X-OSAI-Actor": "operator@example.com"},
            json={"reason": "Create focused follow-up from failed E2E run"},
        )
        self.assertEqual(follow_up.status_code, 200, follow_up.text)
        loop = self.client.post(f"/tasks/{task['id']}/loop/next", json={"run_id": run["id"]})
        self.assertEqual(loop.status_code, 200, loop.text)
        self.assertIn(loop.json()["next_action"], {"re_execute", "create_follow_up_task", "escalate_to_human", "wait_for_approval"})

    def test_e2e_persisted_autonomy_override_uses_authenticated_actor(self):
        _project, _plan, task = self._create_approved_task()
        response = self.client.post(
            f"/tasks/{task['id']}/autonomy/override",
            headers={"X-OSAI-Actor": "operator@example.com"},
            json={
                "operator": "spoofed@example.com",
                "reason": "Keep this task under explicit review.",
                "force_autonomy_mode": "review_required",
                "disable_retries": True,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["operator"], "operator@example.com")
        self.assertTrue(response.json()["disable_retries"])
        dispatch = self.client.post(f"/tasks/{task['id']}/evaluate-dispatch")
        self.assertEqual(dispatch.status_code, 200, dispatch.text)
        autonomy = self.client.get(f"/tasks/{task['id']}/autonomy")
        self.assertEqual(autonomy.status_code, 200, autonomy.text)
        self.assertEqual(autonomy.json()["active_overrides"][0]["operator"], "operator@example.com")

        block = self.client.post(
            f"/tasks/{task['id']}/autonomy/override",
            headers={"X-OSAI-Actor": "operator@example.com"},
            json={"reason": "Pause execution for operator review.", "force_autonomy_mode": "blocked"},
        )
        self.assertEqual(block.status_code, 200, block.text)
        unblock = self.client.post(
            f"/tasks/{task['id']}/unblock",
            headers={"X-OSAI-Actor": "operator@example.com"},
            json={"reason": "Resume under the remaining review policy."},
        )
        self.assertEqual(unblock.status_code, 200, unblock.text)
        self.assertFalse(
            any(item["force_autonomy_mode"] == "blocked" for item in unblock.json()["active_overrides"])
        )
        escalation = self.client.post(
            f"/tasks/{task['id']}/escalate",
            headers={"X-OSAI-Actor": "operator@example.com"},
            json={"reason": "Hand this task to a human owner."},
        )
        self.assertEqual(escalation.status_code, 200, escalation.text)
        self.assertEqual(escalation.json()["status"], "escalated")


if __name__ == "__main__":
    unittest.main()
