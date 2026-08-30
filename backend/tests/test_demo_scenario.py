"""
Payment Outage Demo Scenario End-to-End Test Suite
Validates the complete 11-point judge-verifiable demonstration workflow:
1. Incident creation (CRITICAL Payment Outage)
2. 4 Participants (Commander, Backend Eng, Support Lead, Biz Lead)
3. Transcript observation ingestion
4. Structured extraction (Facts, Hypotheses, Decisions, Action Items, Risks)
5. Conflicting claims detection (DB Exhausted vs Normal Metrics)
6. Missing information detection (PgBouncer socket telemetry)
7. Action item ownership and due time assignment
8. Real-time timeline logging
9. Safe action approval with human confirmation
10. Dangerous action rejection
11. Evidence-bounded final summary with explicit AI disclaimer
12. Simulated transcript injection endpoint
"""

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.engine.simulator import simulator


@pytest.mark.asyncio
async def test_payment_outage_scenario_end_to_end():
    """Run full deterministic Payment Outage scenario and assert all 11 required capabilities."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/demo/payment-outage/run-all")
        assert res.status_code == 200
        data = res.json()

        assert data["status"] == "success"
        assert data["demo_mode"] is True
        assert data["scenario"] == "Payment system outage"
        assert len(data["demonstrated_capabilities"]) >= 10

        inc_id = data["incident_id"]
        assert inc_id == "inc-demo-payment-outage"

        # 1. Incident status and severity
        state = data["state"]
        assert state["event_type"] == "PAYMENT_OUTAGE"
        assert state["severity"] == "CRITICAL"
        assert state["status"] in ("RECOVERING", "RESOLVING")

        # 2. Four participant roles
        participants = state["participants"]
        assert len(participants) == 4
        roles = {p["role"] for p in participants}
        expected_roles = {"INCIDENT_COMMANDER", "ENGINEER", "SUPPORT", "BUSINESS_LEADERSHIP"}
        assert expected_roles.issubset(roles)

        # 3. Observations & Extraction
        observations = state["observations"]
        assert len(observations) >= 6
        claims = state["claims"]
        assert len(claims) >= 4

        # 4. Confirmed facts, decisions, risks
        facts = [c for c in claims if c["status"] == "CONFIRMED" and c["claim_type"] != "decision"]
        assert len(facts) >= 1
        decisions = [c for c in claims if c["claim_type"] == "decision"]
        assert len(decisions) >= 1
        assert "Stripe" in decisions[0]["value"] or "secondary" in decisions[0]["value"]
        assert len(state["unresolved_risks"]) >= 1

        # 5. Conflicting claims
        conflicts = state["conflicts"]
        assert len(conflicts) >= 1
        assert "database" in conflicts[0]["entity"].lower()
        assert conflicts[0]["speaker_a"] != conflicts[0]["speaker_b"]

        # 6. Missing information
        missing = state["missing_info"]
        assert len(missing) >= 1
        assert "pgbouncer" in missing[0]["description"].lower() or "socket" in missing[0]["description"].lower()

        # 7. Action item ownership and due time
        action_items = state["action_items"]
        assert len(action_items) >= 1
        task = action_items[0]
        assert task["owner_name"] == "Dave Miller"
        assert task["due_at"] is not None
        assert task["status"] == "OPEN"

        # 8. Timeline entries
        timeline = state["timeline"]
        assert len(timeline) >= 6
        events = {t["event_type"] for t in timeline}
        assert "INCIDENT_INITIALIZED" in events
        assert "CONFLICT_DETECTED" in events
        assert "DECISION_RECORDED" in events
        assert "ACTION_APPROVED" in events
        assert "ACTION_REJECTED" in events

        # 9. Human approval of safe action
        actions_taken = state["actions_taken"]
        assert len(actions_taken) >= 1
        assert actions_taken[0]["verified"] is True
        assert "Payment traffic successfully rerouted" in actions_taken[0]["result_summary"]

        # 10. Human rejection of dangerous action
        proposed = state["proposed_actions"]
        rejected = [a for a in proposed if a["status"] == "REJECTED"]
        assert len(rejected) >= 1
        assert rejected[0]["tool_name"] == "flush_all_production_databases"

        # 11. Final summary with disclaimer
        final_summary = state["final_summary"]
        assert final_summary is not None
        assert "Confirmed Facts:" in final_summary
        assert "Decisions Made:" in final_summary
        assert "Rejected Dangerous Actions:" in final_summary
        assert "DISCLAIMER: The AI has organized reported evidence and has not independently determined root cause." in final_summary


@pytest.mark.asyncio
async def test_simulate_transcript_injection():
    """Verify custom simulated transcript injection into incident."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # First ensure incident exists
        await client.post("/api/demo/payment-outage/run-all")

        # Inject simulated observation
        res = await client.post(
            "/api/demo/simulate-transcript",
            json={
                "incident_id": "inc-demo-payment-outage",
                "speaker": "Priya Sharma",
                "speaker_role": "SUPPORT",
                "raw_utterance": "Stripe dashboard confirms 100% of payment retries are succeeding on secondary gateway.",
                "source": "demo_transcript_simulation",
            },
        )
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ingested"
        assert data["demo_mode"] is True
        assert data["observation"]["speaker"] == "Priya Sharma"


@pytest.mark.asyncio
async def test_action_item_check_reminders_and_completion_endpoints():
    """Verify manual reminder scan endpoint and manual action completion endpoint."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        await client.post("/api/demo/payment-outage/run-all")

        # 1. Trigger reminder check endpoint
        rem_res = await client.post("/api/incidents/inc-demo-payment-outage/check-reminders")
        assert rem_res.status_code == 200
        assert "overdue_reminders_emitted" in rem_res.json()

        # 2. Complete action item
        comp_res = await client.post(
            "/api/incidents/inc-demo-payment-outage/action-items/act-item-demo-1/complete",
            json={"evidence": "PgBouncer proxy restarted and connection pooling normalized"},
        )
        assert comp_res.status_code == 200
        assert comp_res.json()["action_item"]["status"] == "COMPLETE"
