"""
Incident Purge Test Suite

Covers DELETE /api/incidents/{id} — the endpoint behind "leave the channel and
wipe the record". Each voice session opens its own incident and purges it on
leave, so this path runs constantly and its failure mode is the worst kind for
this product: evidence from a previous conversation surviving into the next one,
where it reads as something the current participants said.

What is asserted here:
1. A fully-populated incident (claims, conflicts, action items, timeline,
   participants, summaries) is removed completely, not just its parent row.
2. Purging is idempotent — a second delete, a retry, or a double-click succeeds.
3. A purged id is genuinely reusable: recreating it yields an empty incident.
"""

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_purge_removes_a_fully_populated_incident():
    """
    The demo scenario produces an incident with rows in nearly every child table.
    Deleting only the `incidents` row would raise a foreign-key violation (the
    child tables reference it without ON DELETE CASCADE), so this is the test that
    the purge actually walks the children first.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/demo/identity-outage/run-all",
            json={"incident_id": "test-purge-populated"},
        )
        assert res.status_code == 200
        inc_id = res.json()["incident_id"]
        assert inc_id == "test-purge-populated"

        # Confirm it is genuinely populated before deleting, so a passing test
        # can't be an artifact of having deleted an already-empty incident.
        state = (await client.get(f"/api/incidents/{inc_id}")).json()
        assert len(state["claims"]) > 0
        assert len(state["timeline"]) > 0
        assert len(state["participants"]) > 0

        purge = await client.delete(f"/api/incidents/{inc_id}")
        assert purge.status_code == 200
        assert purge.json()["existed"] is True
        assert purge.json()["purged"] is True

        # Gone, not emptied.
        assert (await client.get(f"/api/incidents/{inc_id}")).status_code == 404
        listed = (await client.get("/api/incidents")).json()
        assert all(i["incident_id"] != inc_id for i in listed)


@pytest.mark.asyncio
async def test_purge_is_idempotent():
    """
    Leave-channel must never surface a failure for a retry or a double-click, so
    deleting an id that holds nothing is a success with `existed: false`, not a 404.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        await client.post(
            "/api/incidents",
            json={"title": "Untitled", "event_type": "TECHNICAL_INCIDENT",
                  "incident_id": "test-purge-idempotent"},
        )

        first = await client.delete("/api/incidents/test-purge-idempotent")
        assert first.status_code == 200
        assert first.json()["existed"] is True

        second = await client.delete("/api/incidents/test-purge-idempotent")
        assert second.status_code == 200
        assert second.json()["existed"] is False

        never_existed = await client.delete("/api/incidents/test-purge-no-such-room")
        assert never_existed.status_code == 200
        assert never_existed.json()["existed"] is False


@pytest.mark.asyncio
async def test_purged_room_id_is_reusable_and_comes_back_empty():
    """
    Rejoining a channel with a previously-used name must open a genuinely fresh
    record. This is the actual user-facing guarantee: what you see in a room is
    only ever what the current conversation produced.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        room = "test-purge-reused-room"
        await client.post("/api/demo/identity-outage/run-all", json={"incident_id": room})
        seeded = (await client.get(f"/api/incidents/{room}")).json()
        assert len(seeded["claims"]) > 0

        await client.delete(f"/api/incidents/{room}")

        recreated = await client.post(
            "/api/incidents",
            json={"title": "Untitled Incident — Awaiting Reports",
                  "event_type": "TECHNICAL_INCIDENT", "incident_id": room},
        )
        assert recreated.status_code == 201
        fresh = recreated.json()
        assert fresh["claims"] == []
        assert fresh["conflicts"] == []
        assert fresh["action_items"] == []
        assert fresh["title"] == "Untitled Incident — Awaiting Reports"

        # Every incident is created with one participant: Tocsin's own agent seat
        # (see simulator.create_incident). What must NOT survive is any of the four
        # humans the demo scenario registered -- their presence would mean the new
        # room inherited the previous conversation's roster.
        assert [p["name"] for p in fresh["participants"]] == ["System Dispatch"]

        await client.delete(f"/api/incidents/{room}")
