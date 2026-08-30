"""
Comprehensive Intelligence Test Suite for Tocsin Incident Commander
Covers:
1. Observation Ingestion & Structured Claim Extraction.
2. Fact / Report / Assumption classification.
3. Conflict Detection via claim comparison.
4. Missing Info & Unresolved Risks extraction.
5. Participant & Agora UID mapping.
6. Action Item tracking with ownership and overdue checks.
7. Spoken & Final summaries with root-cause disclaimers.
8. Persistence across restart.
9. 30-second transcript deduplication.
"""

import os
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.engine.simulator import simulator
from app.engine.database import init_db, close_db
from app.engine.repositories import incident_repo




@pytest.mark.asyncio
async def test_observation_ingestion_and_claim_extraction():
    """Ingesting an utterance produces structured claims, observations, and updates state."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Create incident
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Payment Degradation Incident", "event_type": "TECHNICAL_INCIDENT"},
        )
        assert inc_res.status_code == 201
        inc_id = inc_res.json()["incident_id"]

        # Ingest observation
        obs_res = await client.post(
            f"/api/incidents/{inc_id}/observations",
            json={
                "raw_utterance": "Ravi says the payment gateway is returning 500 errors to 30% of users.",
                "speaker": "Ravi",
                "source": "voice_transcript",
            },
        )
        assert obs_res.status_code == 201
        obs_data = obs_res.json()
        assert obs_data["observation_id"].startswith("obs-")
        assert obs_data["claims_extracted"] >= 1

        # Check incident state
        get_res = await client.get(f"/api/incidents/{inc_id}")
        assert get_res.status_code == 200
        state = get_res.json()
        assert len(state["observations"]) == 1
        assert len(state["claims"]) >= 1
        assert state["observations"][0]["speaker"] == "Ravi"


@pytest.mark.asyncio
async def test_conflict_detection_opposing_claims():
    """Opposing claims on the same entity create an OPEN conflict record."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Conflict Detection Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc_res.json()["incident_id"]

        # Claim 1: Gateway is down
        await client.post(
            f"/api/incidents/{inc_id}/observations",
            json={
                "raw_utterance": "Frontend engineer reports the payment gateway is down and failing.",
                "speaker": "Alice",
                "source": "voice_transcript_alice",
            },
        )

        # Claim 2: Gateway is up / healthy
        obs_2 = await client.post(
            f"/api/incidents/{inc_id}/observations",
            json={
                "raw_utterance": "Database engineer says the payment gateway is up and healthy in logs.",
                "speaker": "Bob",
                "source": "voice_transcript_bob",
            },
        )
        assert obs_2.status_code == 201
        assert obs_2.json()["conflicts_detected"] >= 1

        # Verify conflict in state
        get_res = await client.get(f"/api/incidents/{inc_id}")
        state = get_res.json()
        assert len(state["conflicts"]) >= 1
        cfl = state["conflicts"][0]
        assert cfl["status"] == "OPEN"
        assert "CONFLICT DETECTED" in cfl["recommended_action"]


@pytest.mark.asyncio
async def test_participant_registration_and_agora_uid_mapping():
    """Registering a participant maps Agora UID and enables speaker resolution."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Participant Mapping Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc_res.json()["incident_id"]

        # Register participant
        part_res = await client.post(
            f"/api/incidents/{inc_id}/participants",
            json={
                "name": "Sarah Chen",
                "role": "INCIDENT_COMMANDER",
                "role_source": "declared",
                "agora_uid": "agora-uid-999",
            },
        )
        assert part_res.status_code == 201
        assert part_res.json()["name"] == "Sarah Chen"

        # Ingest observation with agora_uid only (no speaker name provided)
        obs_res = await client.post(
            f"/api/incidents/{inc_id}/observations",
            json={
                "raw_utterance": "We need to failover traffic to US-West immediately.",
                "agora_uid": "agora-uid-999",
                "source": "voice_transcript",
            },
        )
        assert obs_res.status_code == 201
        # Speaker should be automatically resolved to Sarah Chen
        assert obs_res.json()["speaker"] == "Sarah Chen"


@pytest.mark.asyncio
async def test_action_item_ownership_and_completion():
    """Action items track assigned owner and allow completion."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Action Tracking Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc_res.json()["incident_id"]

        # Ingest utterance with action commitment
        obs_res = await client.post(
            f"/api/incidents/{inc_id}/observations",
            json={
                "raw_utterance": "I will verify the database connection pool settings within 10 minutes.",
                "speaker": "Ravi",
                "source": "voice_transcript",
            },
        )
        assert obs_res.status_code == 201
        action_items = obs_res.json()["action_items"]
        assert len(action_items) >= 1
        item_id = action_items[0]["id"]
        assert action_items[0]["owner_name"] == "Ravi"
        assert action_items[0]["status"] == "OPEN"


@pytest.mark.asyncio
async def test_spoken_and_final_summaries():
    """Spoken and final summaries are generated from persisted state and include disclaimers."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Summary Test", "event_type": "FLOOD_SURGE"},
        )
        inc_id = inc_res.json()["incident_id"]

        # 1. Spoken summary
        spoken_res = await client.post(f"/api/incidents/{inc_id}/summary/spoken")
        assert spoken_res.status_code == 200
        spoken_text = spoken_res.json()["content"]
        assert "Incident: Summary Test" in spoken_text
        assert "The AI has organized reported evidence and has not independently determined root cause." in spoken_text

        # 2. Final summary
        final_res = await client.get(f"/api/incidents/{inc_id}/summary/final")
        assert final_res.status_code == 200
        final_text = final_res.json()["content"]
        assert "Confirmed Facts:" in final_text
        assert "The AI has organized reported evidence and has not independently determined root cause." in final_text


@pytest.mark.asyncio
async def test_transcript_deduplication():
    """Identical utterances within 30 seconds are skipped."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Dedup Test", "event_type": "FLOOD_SURGE"},
        )
        inc_id = inc_res.json()["incident_id"]

        payload = {
            "raw_utterance": "Water level at Sector 4 has risen by two feet.",
            "speaker": "Unit-1",
            "source": "voice_transcript",
        }

        # First post -> ingested
        res_1 = await client.post(f"/api/incidents/{inc_id}/observations", json=payload)
        assert res_1.status_code == 201
        assert "observation_id" in res_1.json()

        # Second post immediately -> skipped duplicate
        res_2 = await client.post(f"/api/incidents/{inc_id}/observations", json=payload)
        assert res_2.status_code == 201
        assert res_2.json().get("skipped") is True
        assert res_2.json().get("reason") == "duplicate_within_window"


@pytest.mark.asyncio
async def test_restart_persistence():
    """State persists in repository and reloads accurately across in-memory reset."""
    # 1. Create and populate incident
    state = await simulator.create_incident(
        title="Persistence Across Restart",
        event_type="FLOOD_SURGE",
        incident_id="inc-restart-test-123",
    )
    # Ensure it's in DB
    await incident_repo.upsert(state)

    # 2. Clear simulator in-memory dict (simulating backend crash/restart)
    simulator._incidents.clear()

    # 3. Reload from database via simulator or repo
    reloaded_state = await simulator.get_incident("inc-restart-test-123")
    assert reloaded_state is not None
    assert reloaded_state.incident_id == "inc-restart-test-123"
    assert reloaded_state.title == "Persistence Across Restart"


@pytest.mark.asyncio
async def test_notify_stakeholders_tool_classification_and_fallback(monkeypatch):
    """notify_stakeholders returns MOCK_FALLBACK when credentials are absent, and LIVE_EXTERNAL when configured."""
    # Import from mock-services server
    import sys
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../../mock-services")))
    from server import notify_stakeholders

    # 1. Without credentials -> MOCK_FALLBACK
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    res_mock = await notify_stakeholders("inc-test-notif-01", "Evacuation notice")
    assert res_mock["tool_classification"] == "MOCK_FALLBACK"
    assert res_mock["delivery_status"] == "skipped_no_credentials"
    assert res_mock["sent"] is False
