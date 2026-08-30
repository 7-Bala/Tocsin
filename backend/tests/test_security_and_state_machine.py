"""
Security and State Machine Hardening Tests
Verifies:
1. Commander authorization enforcement (no hardcoded fallbacks).
2. /resolve endpoint authentication requirement.
3. Action approval state machine (PROPOSED -> PENDING_APPROVAL -> APPROVED -> EXECUTING -> VERIFIED/FAILED).
4. Terminal rejection (REJECTED cannot be approved).
5. Idempotent approval and conflict handling (409 on duplicate/invalid state).
"""

import os
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_commander_key_not_hardcoded(monkeypatch):
    """If TOCSIN_COMMANDER_KEY is not set or empty, approval returns 503."""
    monkeypatch.delenv("TOCSIN_COMMANDER_KEY", raising=False)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Create incident
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Security Auth Test", "event_type": "FLOOD_SURGE"},
        )
        assert inc_res.status_code == 201
        inc_id = inc_res.json()["incident_id"]

        # Propose action
        prop_res = await client.post(
            f"/api/incidents/{inc_id}/actions/propose",
            json={
                "tool_name": "deploy_barriers",
                "rationale": "Protect sector A",
                "recovery_duration_seconds": 2.0,
            },
        )
        assert prop_res.status_code == 201
        action_id = prop_res.json()["proposed_actions"][-1]["action_id"]

        # Attempt approval with old hardcoded default token
        app_res = await client.post(
            f"/api/incidents/{inc_id}/actions/{action_id}/approve",
            headers={"X-Tocsin-Auth": "tocsin-commander-key"},
            json={"commander_id": "Commander-1"},
        )
        assert app_res.status_code == 503
        assert "TOCSIN_COMMANDER_KEY is not configured" in app_res.json()["detail"]


@pytest.mark.asyncio
async def test_resolve_endpoint_requires_auth(monkeypatch):
    """The /resolve endpoint must require authentication."""
    monkeypatch.setenv("TOCSIN_COMMANDER_KEY", "secret-test-commander-key")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Resolve Auth Test", "event_type": "FLOOD_SURGE"},
        )
        inc_id = inc_res.json()["incident_id"]

        # 1. Unauthenticated -> 401
        res_no_auth = await client.post(
            f"/api/incidents/{inc_id}/resolve",
            json={
                "tool_name": "deploy_water_filtration",
                "action_description": "Emergency filtration",
            },
        )
        assert res_no_auth.status_code == 401

        # 2. Wrong token -> 403
        res_wrong_auth = await client.post(
            f"/api/incidents/{inc_id}/resolve",
            headers={"X-Tocsin-Auth": "wrong-token"},
            json={
                "tool_name": "deploy_water_filtration",
                "action_description": "Emergency filtration",
            },
        )
        assert res_wrong_auth.status_code == 403

        # 3. Correct token -> 200
        res_auth = await client.post(
            f"/api/incidents/{inc_id}/resolve",
            headers={"X-Tocsin-Auth": "secret-test-commander-key"},
            json={
                "tool_name": "deploy_water_filtration",
                "action_description": "Emergency filtration",
            },
        )
        assert res_auth.status_code == 200
        assert res_auth.json()["status"] == "RESOLVING"


@pytest.mark.asyncio
async def test_rejected_action_is_terminal(monkeypatch):
    """A rejected action cannot be approved afterwards."""
    monkeypatch.setenv("TOCSIN_COMMANDER_KEY", "secret-key")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Terminal Rejection Test", "event_type": "FLOOD_SURGE"},
        )
        inc_id = inc_res.json()["incident_id"]

        prop_res = await client.post(
            f"/api/incidents/{inc_id}/actions/propose",
            json={
                "tool_name": "evacuate_zone_4",
                "rationale": "High water levels",
            },
        )
        action_id = prop_res.json()["proposed_actions"][-1]["action_id"]

        # Reject action
        rej_res = await client.post(
            f"/api/incidents/{inc_id}/actions/{action_id}/reject",
            headers={"X-Tocsin-Auth": "secret-key"},
            json={"commander_id": "Commander-1", "reason": "Zone 4 is currently secure"},
        )
        assert rej_res.status_code == 200
        assert rej_res.json()["proposed_actions"][-1]["status"] == "REJECTED"

        # Attempt to approve rejected action -> 409 Conflict
        app_res = await client.post(
            f"/api/incidents/{inc_id}/actions/{action_id}/approve",
            headers={"X-Tocsin-Auth": "secret-key"},
            json={"commander_id": "Commander-1"},
        )
        assert app_res.status_code == 409
        assert "REJECTED actions are terminal" in app_res.json()["detail"]


@pytest.mark.asyncio
async def test_duplicate_approval_conflict(monkeypatch):
    """Approving an already EXECUTING action returns 409 Conflict."""
    monkeypatch.setenv("TOCSIN_COMMANDER_KEY", "secret-key")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Duplicate Approval Test", "event_type": "FLOOD_SURGE"},
        )
        inc_id = inc_res.json()["incident_id"]

        prop_res = await client.post(
            f"/api/incidents/{inc_id}/actions/propose",
            json={
                "tool_name": "dispatch_boats",
                "rationale": "Rescue stranded party",
            },
        )
        action_id = prop_res.json()["proposed_actions"][-1]["action_id"]

        # Approve once
        app_1 = await client.post(
            f"/api/incidents/{inc_id}/actions/{action_id}/approve",
            headers={"X-Tocsin-Auth": "secret-key"},
            json={"commander_id": "Commander-1"},
        )
        assert app_1.status_code == 200

        # Duplicate approval -> 409 Conflict
        app_2 = await client.post(
            f"/api/incidents/{inc_id}/actions/{action_id}/approve",
            headers={"X-Tocsin-Auth": "secret-key"},
            json={"commander_id": "Commander-1"},
        )
        assert app_2.status_code == 409
