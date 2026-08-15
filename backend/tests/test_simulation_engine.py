"""
Automated Test Suite for Tocsin Incident-State Simulation Engine
Tests non-linear degradation with jitter, resolution recovery, and API / WebSocket streaming.
"""

import asyncio

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from app.engine.simulator import simulator
from app.main import app
from app.models.incident import (
    EventType,
    IncidentStatus,
    SeverityLevel,
    TriggerEventRequest,
    TriggerResolutionRequest,
)


@pytest.mark.asyncio
async def test_incident_degradation_and_recovery_lifecycle():
    """
    Test full simulation loop:
    1. Create incident in IDLE state.
    2. Trigger FLOOD_SURGE event -> State degrades with jitter.
    3. Assert state degrades measurably (severity rises, flood depth rises).
    4. Trigger resolution action with recovery duration.
    5. Assert state recovers and stabilizes at nominal baseline.
    """
    incident_id = "test-inc-lifecycle-001"
    initial_state = await simulator.create_incident(
        title="Downtown Flash Flood Warning",
        event_type=EventType.FLOOD_SURGE,
        incident_id=incident_id,
        initial_symptoms=["Heavy runoff reported near River St."],
    )

    assert initial_state.incident_id == incident_id
    assert initial_state.status == IncidentStatus.IDLE
    assert initial_state.severity == SeverityLevel.LOW
    assert initial_state.metrics.severity_score == 10.0
    assert initial_state.metrics.flood_depth_meters == 0.0
    assert len(initial_state.timeline) >= 1

    # 2. Trigger Event
    trigger_req = TriggerEventRequest(
        event_type=EventType.FLOOD_SURGE,
        intensity=1.5,
        description="Flash flood waters breached main culvert.",
        caller_id="Caller-Unit-9",
    )
    degrading_state = await simulator.trigger_event(incident_id, trigger_req)
    assert degrading_state.status == IncidentStatus.DEGRADING
    assert any(p.name == "Caller-Unit-9" for p in degrading_state.participants)

    # 3. Wait for degradation loop ticks
    await asyncio.sleep(1.8)

    snapshot_degraded = await simulator.get_incident(incident_id)
    assert snapshot_degraded is not None
    # Assert state got worse
    assert snapshot_degraded.metrics.severity_score > 12.0
    assert snapshot_degraded.metrics.flood_depth_meters > 0.1
    assert snapshot_degraded.metrics.water_safety_index < 95.0
    assert snapshot_degraded.metrics.affected_population > 0
    degraded_score_1 = snapshot_degraded.metrics.severity_score

    # Wait another tick to verify dynamic degradation progression
    await asyncio.sleep(1.0)
    snapshot_degraded_2 = await simulator.get_incident(incident_id)
    assert snapshot_degraded_2.metrics.severity_score > degraded_score_1

    # 4. Trigger Resolution Action
    res_req = TriggerResolutionRequest(
        tool_name="deploy_flood_barriers_and_drainage",
        action_description="Deployed rapid barrier walls and active drainage pumps.",
        recovery_duration_seconds=2.0,
        actor="AgoraVoiceAgent",
        parameters={"sector": "Downtown", "pump_units": 4},
    )
    resolving_state = await simulator.trigger_resolution(incident_id, res_req)
    assert resolving_state.status == IncidentStatus.RESOLVING
    assert len(resolving_state.actions_taken) == 1
    assert resolving_state.actions_taken[0].tool_name == "deploy_flood_barriers_and_drainage"
    assert resolving_state.actions_taken[0].verified is False

    # 5. Wait for recovery loop to complete (+ small buffer for stabilization)
    await asyncio.sleep(2.6)

    final_state = await simulator.get_incident(incident_id)
    assert final_state is not None
    assert final_state.status == IncidentStatus.STABILIZED
    assert final_state.severity == SeverityLevel.LOW
    assert final_state.metrics.severity_score == 10.0
    assert final_state.metrics.flood_depth_meters == 0.0
    assert final_state.metrics.water_safety_index >= 90.0
    assert final_state.actions_taken[0].verified is True
    assert any(t.event_type == "INCIDENT_STABILIZED" for t in final_state.timeline)


@pytest.mark.asyncio
async def test_rest_api_endpoints():
    """
    Test REST API endpoints for incident operations:
    - POST /api/incidents
    - GET /api/incidents
    - GET /api/incidents/{id}
    - POST /api/incidents/{id}/trigger
    - POST /api/incidents/{id}/resolve
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Create incident
        create_res = await client.post(
            "/api/incidents",
            json={
                "incident_id": "test-inc-api-999",
                "title": "Industrial Spill Contamination",
                "event_type": "WATER_CONTAMINATION",
                "initial_symptoms": ["Chemical odor reported in water supply"],
            },
        )
        assert create_res.status_code == 201
        data = create_res.json()
        assert data["incident_id"] == "test-inc-api-999"
        assert data["status"] == "IDLE"

        # List incidents
        list_res = await client.get("/api/incidents")
        assert list_res.status_code == 200
        assert len(list_res.json()) >= 1

        # Get specific incident
        get_res = await client.get("/api/incidents/test-inc-api-999")
        assert get_res.status_code == 200
        assert get_res.json()["title"] == "Industrial Spill Contamination"

        # Trigger event
        trigger_res = await client.post(
            "/api/incidents/test-inc-api-999/trigger",
            json={
                "event_type": "WATER_CONTAMINATION",
                "intensity": 1.2,
                "description": "Runoff penetrated Sector 3 treatment facility.",
                "caller_id": "Field-Officer-Bravo",
            },
        )
        assert trigger_res.status_code == 200
        assert trigger_res.json()["status"] == "DEGRADING"

        # Trigger resolution
        resolve_res = await client.post(
            "/api/incidents/test-inc-api-999/resolve",
            json={
                "tool_name": "activate_activated_carbon_filtration",
                "action_description": "Engaged auxiliary carbon filtration bank.",
                "recovery_duration_seconds": 1.5,
                "parameters": {"filter_bank": "Sector3_Carbon"},
            },
        )
        assert resolve_res.status_code == 200
        assert resolve_res.json()["status"] == "RESOLVING"
        assert len(resolve_res.json()["actions_taken"]) == 1


def test_websocket_snapshot_stream():
    """
    Test WebSocket endpoint connection, initial state snapshot receipt, and interactive echo.
    """
    client = TestClient(app)
    # Create incident first
    res = client.post(
        "/api/incidents",
        json={
            "incident_id": "test-ws-stream-101",
            "title": "Power Substation Failure",
            "event_type": "POWER_FAILURE",
        },
    )
    assert res.status_code == 201

    with client.websocket_connect("/ws/incidents/test-ws-stream-101") as websocket:
        initial_msg = websocket.receive_json()
        assert initial_msg["type"] == "INCIDENT_SNAPSHOT"
        assert initial_msg["incident_id"] == "test-ws-stream-101"
        assert initial_msg["state"]["title"] == "Power Substation Failure"

        websocket.send_text("client_ping")
        ack_msg = websocket.receive_json()
        assert ack_msg["type"] == "ACK"
        assert ack_msg["payload"] == "client_ping"
