import json
import unittest

from sqlmodel import SQLModel, Session, create_engine

from app.ai_models import JiraIssueMapping
from app.models import Plan, Project, Task
from app.services.jira_integration import sync_task_to_jira


class JiraIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(self.engine)
        self.session = Session(self.engine)
        project = Project(name="Jira", description="sync test")
        self.session.add(project)
        self.session.commit()
        plan = Plan(project_id=project.id, version=1, title="Approved", status="approved")
        self.session.add(plan)
        self.session.commit()
        self.task = Task(
            plan_id=plan.id,
            position=1,
            task_type="implementation",
            title="Create durable issue",
            instructions="Create one Jira issue through a persisted idempotency mapping.",
        )
        self.session.add(self.task)
        self.session.commit()
        self.environment = {
            "OSAI_JIRA_ENABLED": "true",
            "OSAI_JIRA_BASE_URL": "https://jira.example.test",
            "OSAI_JIRA_PROJECT_KEY": "OSAI",
            "OSAI_JIRA_BEARER_TOKEN": "test-secret",
            "OSAI_JIRA_READY_LABEL": "osai-ready",
            "OSAI_JIRA_ISSUE_TYPE": "Task",
        }

    def tearDown(self):
        self.session.close()

    def test_sync_creates_one_issue_and_reuses_the_mapping(self):
        requests = []

        def transport(url, headers, body, timeout):
            requests.append((url, headers, body))
            if "/search?" in url:
                return {"issues": []}
            self.assertEqual(url, "https://jira.example.test/rest/api/3/issue")
            payload = json.loads(body.decode("utf-8"))
            self.assertIn(f"osai-task-{self.task.id}", payload["fields"]["labels"])
            return {"key": "OSAI-42"}

        first = sync_task_to_jira(
            self.session,
            task=self.task,
            actor="operator@example.com",
            environ=self.environment,
            transport=transport,
        )
        second = sync_task_to_jira(
            self.session,
            task=self.task,
            actor="operator@example.com",
            environ=self.environment,
            transport=transport,
        )

        self.assertEqual(first.id, second.id)
        self.assertEqual(first.sync_status, "synchronized")
        self.assertEqual(first.external_issue_key, "OSAI-42")
        self.assertEqual(len([request for request in requests if request[2] is not None]), 1)
        self.session.refresh(self.task)
        self.assertEqual(self.task.input_payload["jira_issue_key"], "OSAI-42")
        mapping = self.session.get(JiraIssueMapping, first.id)
        self.assertNotIn("test-secret", str(mapping.request_payload))
