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


@pytest.mark.asyncio
async def test_repeat_overdue_reminders_do_not_duplicate_timeline_entries():
    """
    Regression test for a live-observed defect (2026-08-31): a background worker calls
    check_and_remind_overdue_actions() every 5s for every loaded incident. The 60s
    throttle only limits reminder *frequency* — left unbounded, an item that stays
    overdue for an hour produced ~60 duplicate "is OVERDUE" timeline rows (one demo
    incident reached 120+ timeline events, almost all duplicates), burying genuinely
    new events and making the incident look far more active than it actually was.

    The fix: only the first reminder for a given overdue occurrence writes a timeline
    entry. Repeat throttled reminders still fire (for a live WebSocket "still overdue"
    nudge) but must not add a second row to the persisted timeline.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Repeat Reminder Dedup Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc_res.json()["incident_id"]

        state = await simulator.get_incident(inc_id)
        assert state is not None

        past_due = (datetime.now(timezone.utc) - timedelta(minutes=90)).isoformat()
        item = ActionItem(
            id="act-item-test-repeat-overdue-1",
            incident_id=inc_id,
            description="Compare authentication error rates before and after deployment",
            owner_name="Dave Miller",
            status="OPEN",
            due_at=past_due,
        )
        state.action_items.append(item)

        # First check: new occurrence -> exactly one timeline entry.
        reminders_1 = await simulator.check_and_remind_overdue_actions(inc_id)
        assert len(reminders_1) == 1
        followup_entries = [t for t in state.timeline if t.event_type == "FOLLOWUP_REMINDER"]
        assert len(followup_entries) == 1

        # Simulate the 60s throttle window having elapsed (as the background worker
        # would encounter after ~12 five-second polls) by backdating last_reminder_at,
        # rather than sleeping in the test.
        for _ in range(5):
            item.last_reminder_at = (datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat()
            reminders_n = await simulator.check_and_remind_overdue_actions(inc_id)
            # The live "still overdue" nudge keeps firing...
            assert len(reminders_n) == 1
            assert reminders_n[0]["action_id"] == "act-item-test-repeat-overdue-1"

        # ...but the persisted timeline must still hold exactly one entry, not six.
        followup_entries_after = [t for t in state.timeline if t.event_type == "FOLLOWUP_REMINDER"]
        assert len(followup_entries_after) == 1, (
            f"expected exactly 1 deduplicated timeline entry, got {len(followup_entries_after)}"
        )
