import unittest

from sqlmodel import SQLModel, Session, create_engine

from app.api.operator import get_operator_queue
from app.models import Approval, Plan, Project, Task


class OperatorQueueTests(unittest.TestCase):
    def test_queue_includes_pending_approval_and_actionable_task(self):
        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            project = Project(name="Queue", description="operator queue")
            session.add(project)
            session.commit()
            plan = Plan(project_id=project.id, version=1, title="Review plan", status="draft")
            session.add(plan)
            session.commit()
            session.add(Approval(plan_id=plan.id, requested_by="agent:planner", status="pending"))
            session.add(
                Task(
                    plan_id=plan.id,
                    position=1,
                    task_type="implementation",
                    title="Clarify execution scope",
                    instructions="Needs an operator decision before work can continue.",
                    status="needs_context",
                )
            )
            session.commit()

            queue = get_operator_queue(limit=50, session=session)

        self.assertEqual(queue.total, 2)
        self.assertEqual({item.item_type for item in queue.items}, {"plan_approval", "task_attention"})
