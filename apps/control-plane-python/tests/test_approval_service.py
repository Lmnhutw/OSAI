import unittest
from datetime import timedelta

from sqlmodel import SQLModel, Session, create_engine

from app.models import Plan, Project
from app.services.approval_service import ApprovalConflictError, decide_plan_approval, request_plan_approval


class ApprovalServiceTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(self.engine)
        self.session = Session(self.engine)
        project = Project(name="Approvals", description="approval service test")
        self.session.add(project)
        self.session.commit()
        self.plan = Plan(project_id=project.id, version=1, title="Plan", summary="Needs review", status="draft")
        self.session.add(self.plan)
        self.session.commit()
        self.session.refresh(self.plan)

    def tearDown(self):
        self.session.close()

    def test_request_is_idempotent_and_decision_requires_different_actor(self):
        approval = request_plan_approval(
            self.session,
            plan=self.plan,
            actor="requester@example.com",
            note="Please review",
            expected_plan_updated_at=self.plan.updated_at,
            idempotency_key="request-key-0001",
        )
        repeated = request_plan_approval(
            self.session,
            plan=self.plan,
            actor="requester@example.com",
            note="Please review",
            expected_plan_updated_at=self.plan.updated_at,
            idempotency_key="request-key-0001",
        )
        self.assertEqual(repeated.id, approval.id)

        with self.assertRaises(ApprovalConflictError):
            decide_plan_approval(
                self.session,
                approval=approval,
                actor="requester@example.com",
                decision="approved",
                note="self approval",
                expected_plan_updated_at=self.plan.updated_at,
                idempotency_key="decision-key-0001",
            )

        decided = decide_plan_approval(
            self.session,
            approval=approval,
            actor="approver@example.com",
            decision="approved",
            note="approved",
            expected_plan_updated_at=self.plan.updated_at,
            idempotency_key="decision-key-0001",
        )
        self.session.refresh(self.plan)
        self.assertEqual(decided.status, "approved")
        self.assertEqual(decided.approver, "approver@example.com")
        self.assertEqual(self.plan.status, "approved")

    def test_stale_request_is_rejected(self):
        with self.assertRaises(ApprovalConflictError):
            request_plan_approval(
                self.session,
                plan=self.plan,
                actor="requester@example.com",
                note=None,
                expected_plan_updated_at=self.plan.updated_at - timedelta(seconds=1),
                idempotency_key="request-key-0002",
            )
