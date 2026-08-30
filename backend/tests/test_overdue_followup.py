"""
Overdue Action Item Follow-up & Reminder Tests
Verifies:
1. OPEN action item tracking with due timestamps and owner assignment.
2. When due time passes, check_and_remind_overdue_actions() flags item as OVERDUE.
3. FOLLOWUP_REMINDER event is dispatched and recorded in timeline.
4. Reminder throttling prevents duplicate reminder spam within 60 seconds.
5. Marking action item COMPLETE clears pending follow-up.
"""

from datetime import datetime, timedelta, timezone
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.engine.simulator import simulator
from app.models.incident import ActionItem


@pytest.mark.asyncio
async def test_overdue_action_item_detection_and_throttling():
    """Verify overdue detection, reminder emission, and spam throttling."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Create incident
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Overdue Tracking Test", "event_type": "FLOOD_SURGE"},
        )
        inc_id = inc_res.json()["incident_id"]

        state = await simulator.get_incident(inc_id)
        assert state is not None

        # Add an action item whose due_at is 5 minutes in the past
        past_due = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        item = ActionItem(
            id="act-item-test-overdue-1",
            incident_id=inc_id,
            description="Inspect levee integrity in Sector 4",
            owner_name="Engineer Dave",
            status="OPEN",
            due_at=past_due,
        )
        state.action_items.append(item)

        # 1. First overdue check -> triggers reminder
        reminders_1 = await simulator.check_and_remind_overdue_actions(inc_id)
        assert len(reminders_1) == 1
        rem = reminders_1[0]
        assert rem["action_id"] == "act-item-test-overdue-1"
        assert rem["owner_name"] == "Engineer Dave"
        assert rem["minutes_overdue"] >= 5

        # Check that state was updated to OVERDUE and timeline entry added
        assert item.status == "OVERDUE"
        assert item.last_reminder_at is not None
        assert any(t.event_type == "FOLLOWUP_REMINDER" for t in state.timeline)

        # 2. Immediate second check -> throttled (no duplicate spam)
        reminders_2 = await simulator.check_and_remind_overdue_actions(inc_id)
        assert len(reminders_2) == 0

        # 3. Complete action item -> status is COMPLETE
        completed = await simulator.complete_action_item(inc_id, "act-item-test-overdue-1", "Inspection report filed")
        assert completed is not None
        assert completed.status == "COMPLETE"
        assert completed.completion_evidence == "Inspection report filed"
