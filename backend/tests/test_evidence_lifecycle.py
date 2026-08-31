"""
Evidence Lifecycle Test Suite

Covers the capabilities that turn Tocsin from a detector into a workflow:
1. Conflict detector PRECISION — complementary detail must not be reported as
   contradiction (regression test for the "any two different strings conflict" bug).
2. Conflict / missing-info / risk resolution with human attribution, and terminal
   re-resolution semantics (409).
3. Claim provenance tracing ("why do we believe this?").
4. Shift-handoff brief generation in written + spoken form.
"""

import pytest
from httpx import ASGITransport, AsyncClient

from app.engine.conflict_detector import _values_conflict, detect_conflicts
from app.engine.simulator import simulator
from app.main import app
from app.models.incident import ActionItem


# ─── 1. Conflict detector precision ──────────────────────────────────────────


def test_opposing_health_polarity_is_a_conflict():
    """The genuine case: one source says healthy, another says unhealthy."""
    assert _values_conflict("healthy", "down") is True
    assert _values_conflict("operational", "failing") is True
    assert _values_conflict("up and running", "crashed") is True


def test_same_polarity_is_not_a_conflict():
    """Two people describing the same failure differently are not disagreeing."""
    assert _values_conflict("down", "failing") is False
    assert _values_conflict("healthy", "operational") is False


def test_complementary_detail_is_not_a_conflict():
    """
    Regression: previously ANY two different strings about the same entity were
    reported as a contradiction. During a live incident, participants describe the
    same component from different angles; that is corroboration, not disagreement.
    """
    assert _values_conflict("returning 503", "elevated latency") is False
    assert _values_conflict("slow response", "intermittent timeouts") is False
    assert _values_conflict("us-east-1", "eu-west-2") is False


def test_numeric_divergence_beyond_threshold_is_a_conflict():
    """Two incompatible measurements of the same metric remain a real conflict."""
    assert _values_conflict("40% error rate", "5% error rate") is True
    assert _values_conflict("100 connections", "12 connections") is True


def test_close_numeric_values_are_not_a_conflict():
    """Measurement noise within threshold must not raise an interrupt."""
    assert _values_conflict("40% error rate", "42% error rate") is False


def test_detector_does_not_flag_complementary_claims_end_to_end():
    """detect_conflicts must stay silent on corroborating detail about one entity."""
    existing = [
        {
            "id": "clm-existing",
            "entity": "login api",
            "value": "returning 503 errors",
            "source": "voice_transcript_dave",
            "speaker": "Dave Miller",
        }
    ]
    conflicts = detect_conflicts(
        new_entity="login api",
        new_value="elevated p99 latency",
        new_claim_id="clm-new",
        new_source="voice_transcript_priya",
        new_speaker="Priya Sharma",
        existing_claims=existing,
    )
    assert conflicts == []


def test_detector_still_flags_true_contradiction_end_to_end():
    existing = [
        {
            "id": "clm-existing",
            "entity": "authentication database",
            "value": "overloaded and failing",
            "source": "voice_transcript_dave",
            "speaker": "Dave Miller",
        }
    ]
    conflicts = detect_conflicts(
        new_entity="authentication database",
        new_value="healthy, connections normal",
        new_claim_id="clm-new",
        new_source="voice_transcript_priya",
        new_speaker="Priya Sharma",
        existing_claims=existing,
    )
    assert len(conflicts) == 1
    assert conflicts[0]["entity"] == "authentication database"
    assert "CONFLICT DETECTED" in conflicts[0]["recommended_action"]


# ─── 2. Resolution lifecycle ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_conflict_resolution_with_attribution_and_terminal_semantics():
    """
    A detected contradiction must be closable by a named human with stated evidence,
    and resolution must be terminal (re-resolving returns 409).
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/demo/identity-outage/run-all")
        assert res.status_code == 200
        inc_id = res.json()["incident_id"]

        state = (await client.get(f"/api/incidents/{inc_id}")).json()
        assert state["conflicts"], "Demo scenario must seed at least one conflict"
        conflict_id = state["conflicts"][0]["id"]
        assert state["conflicts"][0]["status"] == "OPEN"

        resolve = await client.post(
            f"/api/incidents/{inc_id}/conflicts/{conflict_id}/resolve",
            json={
                "resolved_by": "Commander Sarah Chen",
                "resolution_notes": (
                    "Checked identity-service dashboard directly: DB connection pool at "
                    "22%, Priya's telemetry reading is correct."
                ),
            },
        )
        assert resolve.status_code == 200
        body = resolve.json()
        assert body["status"] == "RESOLVED"
        assert body["resolved_by"] == "Commander Sarah Chen"
        assert body["resolved_at"]
        assert "dashboard" in body["resolution_notes"]

        # Resolution is reflected in incident state
        state2 = (await client.get(f"/api/incidents/{inc_id}")).json()
        resolved = next(c for c in state2["conflicts"] if c["id"] == conflict_id)
        assert resolved["status"] == "RESOLVED"
        assert resolved["resolved_by"] == "Commander Sarah Chen"

        # A CONFLICT_RESOLVED timeline entry was written
        assert any(t["event_type"] == "CONFLICT_RESOLVED" for t in state2["timeline"])

        # Terminal: re-resolving is a 409
        again = await client.post(
            f"/api/incidents/{inc_id}/conflicts/{conflict_id}/resolve",
            json={"resolved_by": "Someone Else", "resolution_notes": "Trying to re-resolve."},
        )
        assert again.status_code == 409


@pytest.mark.asyncio
async def test_resolution_requires_attribution_and_reasoning():
    """Anonymous or unexplained resolution must be rejected by validation."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/demo/identity-outage/run-all")
        inc_id = res.json()["incident_id"]
        state = (await client.get(f"/api/incidents/{inc_id}")).json()
        conflict_id = state["conflicts"][0]["id"]

        # Missing resolution_notes
        r1 = await client.post(
            f"/api/incidents/{inc_id}/conflicts/{conflict_id}/resolve",
            json={"resolved_by": "Commander Sarah Chen"},
        )
        assert r1.status_code == 422

        # Missing resolved_by
        r2 = await client.post(
            f"/api/incidents/{inc_id}/conflicts/{conflict_id}/resolve",
            json={"resolution_notes": "Checked the dashboard."},
        )
        assert r2.status_code == 422


@pytest.mark.asyncio
async def test_missing_info_and_risk_resolution():
    """Information gaps and risks close with the same attribution discipline."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/demo/identity-outage/run-all")
        inc_id = res.json()["incident_id"]
        state = (await client.get(f"/api/incidents/{inc_id}")).json()

        assert state["missing_info"], "Demo scenario must seed a missing-information item"
        mi_id = state["missing_info"][0]["id"]
        mi_res = await client.post(
            f"/api/incidents/{inc_id}/missing-info/{mi_id}/resolve",
            json={
                "resolved_by": "Dave Miller",
                "resolution_notes": "Pulled pre/post-deploy auth error rates: 0.3% before, 41% after.",
            },
        )
        assert mi_res.status_code == 200
        assert mi_res.json()["status"] == "RESOLVED"
        assert mi_res.json()["resolved_by"] == "Dave Miller"

        assert state["unresolved_risks"], "Demo scenario must seed a risk"
        risk_id = state["unresolved_risks"][0]["id"]
        risk_res = await client.post(
            f"/api/incidents/{inc_id}/risks/{risk_id}/resolve",
            json={
                "resolved_by": "Commander Sarah Chen",
                "resolution_notes": "Session invalidation confirmed not triggered by the rollback path.",
            },
        )
        assert risk_res.status_code == 200
        assert risk_res.json()["status"] == "RESOLVED"

        # Both reflected in state, with timeline entries
        final = (await client.get(f"/api/incidents/{inc_id}")).json()
        assert next(m for m in final["missing_info"] if m["id"] == mi_id)["status"] == "RESOLVED"
        assert next(r for r in final["unresolved_risks"] if r["id"] == risk_id)["status"] == "RESOLVED"
        event_types = {t["event_type"] for t in final["timeline"]}
        assert "MISSING_INFO_RESOLVED" in event_types
        assert "RISK_RESOLVED" in event_types


@pytest.mark.asyncio
async def test_resolving_unknown_item_returns_404():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/demo/identity-outage/run-all")
        inc_id = res.json()["incident_id"]

        r = await client.post(
            f"/api/incidents/{inc_id}/conflicts/cfl-does-not-exist/resolve",
            json={"resolved_by": "Commander", "resolution_notes": "n/a"},
        )
        assert r.status_code == 404


# ─── 3. Provenance ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_claim_provenance_returns_full_chain():
    """
    'Why do we believe this?' must return the utterance, speaker, role provenance,
    and extraction method — the verifiability requirement responders actually have.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc = await client.post(
            "/api/incidents",
            json={"title": "Provenance Trace Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc.json()["incident_id"]

        obs = await client.post(
            f"/api/incidents/{inc_id}/observations",
            json={
                "raw_utterance": "The identity service is returning 503 errors for about 40% of logins.",
                "speaker": "Dave Miller",
                "source": "voice_transcript_dave",
            },
        )
        assert obs.status_code == 201
        assert obs.json()["claims_extracted"] >= 1

        state = (await client.get(f"/api/incidents/{inc_id}")).json()
        claim = state["claims"][0]

        prov = await client.get(f"/api/incidents/{inc_id}/claims/{claim['id']}/provenance")
        assert prov.status_code == 200
        p = prov.json()

        assert p["claim"]["id"] == claim["id"]
        assert p["origin"]["raw_utterance"] == (
            "The identity service is returning 503 errors for about 40% of logins."
        )
        assert p["origin"]["observation_id"] == claim["observation_id"]
        assert p["attribution"]["speaker"] == "Dave Miller"
        assert p["extraction"]["method"] in ("llm", "heuristic_fallback")
        assert p["extraction"]["caveat"]
        # Tocsin must always disclaim independent verification
        assert "did not independently verify" in p["verification_note"]


@pytest.mark.asyncio
async def test_provenance_for_unknown_claim_returns_404():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc = await client.post(
            "/api/incidents",
            json={"title": "Provenance 404 Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc.json()["incident_id"]
        r = await client.get(f"/api/incidents/{inc_id}/claims/clm-nope/provenance")
        assert r.status_code == 404


# ─── 4. Handoff brief ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_handoff_brief_structure_and_spoken_form():
    """
    A handoff must produce both a written record and a spoken script from the same
    evidence, and must not claim it broadcast audio it did not broadcast.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/demo/identity-outage/run-all")
        inc_id = res.json()["incident_id"]

        h = await client.get(f"/api/incidents/{inc_id}/handoff")
        assert h.status_code == 200
        body = h.json()

        sections = body["sections"]
        for key in (
            "incident",
            "confirmed_facts",
            "reported_but_unconfirmed",
            "open_contradictions",
            "settled_contradictions",
            "open_questions",
            "ownership",
            "unresolved_risks",
            "record_quality",
        ):
            assert key in sections, f"handoff missing section: {key}"

        assert sections["incident"]["id"] == inc_id
        assert isinstance(body["spoken_brief"], str) and len(body["spoken_brief"]) > 40
        assert "Handoff for" in body["spoken_brief"]

        # Honesty invariants
        assert body["audio_broadcast"] is False
        assert "did not independently determine root cause" in body["ai_disclaimer"]

        # Ownership entries name an owner (or explicitly UNASSIGNED)
        for item in sections["ownership"]:
            assert item["owner"]


@pytest.mark.asyncio
async def test_handoff_moves_conflict_from_open_to_settled_after_resolution():
    """The handoff brief must reflect resolution state, not just detection state."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/demo/identity-outage/run-all")
        inc_id = res.json()["incident_id"]

        before = (await client.get(f"/api/incidents/{inc_id}/handoff")).json()
        assert len(before["sections"]["open_contradictions"]) >= 1
        assert before["open_item_counts"]["contradictions"] >= 1
        conflict_id = before["sections"]["open_contradictions"][0]["conflict_id"]

        await client.post(
            f"/api/incidents/{inc_id}/conflicts/{conflict_id}/resolve",
            json={
                "resolved_by": "Commander Sarah Chen",
                "resolution_notes": "Verified against identity-service telemetry dashboard.",
            },
        )

        after = (await client.get(f"/api/incidents/{inc_id}/handoff")).json()
        open_ids = [c["conflict_id"] for c in after["sections"]["open_contradictions"]]
        settled_ids = [c["conflict_id"] for c in after["sections"]["settled_contradictions"]]
        assert conflict_id not in open_ids
        assert conflict_id in settled_ids
        assert after["open_item_counts"]["contradictions"] == before["open_item_counts"]["contradictions"] - 1

        settled = next(c for c in after["sections"]["settled_contradictions"] if c["conflict_id"] == conflict_id)
        assert settled["resolved_by"] == "Commander Sarah Chen"
        assert settled["resolution_notes"]


@pytest.mark.asyncio
async def test_handoff_discloses_heuristic_fallback_share():
    """
    Record quality must be disclosed: a handoff built largely from keyword-heuristic
    extraction is materially weaker evidence and the incoming commander must be told.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/demo/identity-outage/run-all")
        inc_id = res.json()["incident_id"]

        body = (await client.get(f"/api/incidents/{inc_id}/handoff")).json()
        rq = body["sections"]["record_quality"]
        assert "total_claims" in rq
        assert "heuristic_fallback_claims" in rq
        assert rq["caveat"]
        assert rq["heuristic_fallback_claims"] <= rq["total_claims"]


@pytest.mark.asyncio
async def test_handoff_surfaces_unowned_action_items():
    """
    An action item with no owner is a silent accountability gap. It must be visible in
    the handoff — as a distinct ownership['unowned'] flag, in open_item_counts, and in
    the spoken brief — even before it happens to also go overdue (which would otherwise
    be the only path that currently made the gap visible via "owned by nobody").
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc = await client.post(
            "/api/incidents",
            json={"title": "Unowned Action Item Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc.json()["incident_id"]

        state = await simulator.get_incident(inc_id)
        assert state is not None

        owned = ActionItem(
            id="act-owned-1",
            incident_id=inc_id,
            description="Verify rollback impact",
            owner_name="Dave Miller",
            status="OPEN",
        )
        unowned = ActionItem(
            id="act-unowned-1",
            incident_id=inc_id,
            description="Confirm auth DB connection pool size",
            owner_name=None,
            status="OPEN",
        )
        state.action_items.extend([owned, unowned])

        body = (await client.get(f"/api/incidents/{inc_id}/handoff")).json()

        ownership = {a["action_item_id"]: a for a in body["sections"]["ownership"]}
        assert ownership["act-owned-1"]["unowned"] is False
        assert ownership["act-unowned-1"]["unowned"] is True
        assert ownership["act-unowned-1"]["owner"] == "UNASSIGNED"

        assert body["open_item_counts"]["unowned_actions"] == 1
        assert "no owner assigned" in body["spoken_brief"]
        assert "Confirm auth DB connection pool size" in body["spoken_brief"]


@pytest.mark.asyncio
async def test_handoff_unowned_and_overdue_action_item_not_double_announced():
    """
    An item that is BOTH unowned and overdue is already covered by the overdue line
    ("owned by nobody"). It must still count toward unowned_actions and carry the
    unowned flag, but must not ALSO appear a second time in the "no owner assigned"
    spoken line — that would be double-announcing the same gap.
    """
    from datetime import datetime, timedelta, timezone

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc = await client.post(
            "/api/incidents",
            json={"title": "Unowned Overdue Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc.json()["incident_id"]

        state = await simulator.get_incident(inc_id)
        assert state is not None

        item = ActionItem(
            id="act-unowned-overdue-1",
            incident_id=inc_id,
            description="Patch the vulnerable dependency",
            owner_name=None,
            status="OVERDUE",
            due_at=(datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(),
        )
        state.action_items.append(item)

        body = (await client.get(f"/api/incidents/{inc_id}/handoff")).json()

        assert body["open_item_counts"]["unowned_actions"] == 1
        assert body["open_item_counts"]["overdue_actions"] == 1
        ownership = {a["action_item_id"]: a for a in body["sections"]["ownership"]}
        assert ownership["act-unowned-overdue-1"]["unowned"] is True
        assert ownership["act-unowned-overdue-1"]["overdue"] is True

        # Covered by the overdue line ("owned by nobody"), not the separate unowned line.
        assert "no owner assigned" not in body["spoken_brief"]
        assert "owned by nobody" in body["spoken_brief"]


# ─── 5. Decisions: rationale + supersession ──────────────────────────────────


@pytest.mark.asyncio
async def test_record_decision_with_rationale():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc = await client.post(
            "/api/incidents",
            json={"title": "Decision Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc.json()["incident_id"]

        r = await client.post(
            f"/api/incidents/{inc_id}/decisions",
            json={
                "entity": "Rollback timing",
                "value": "Hold rollback for 10 minutes",
                "rationale": "Need to confirm deployment correlation first",
                "decided_by": "Commander Chen",
            },
        )
        assert r.status_code == 200
        decision = r.json()["decision"]
        assert decision["claim_type"] == "decision"
        assert decision["rationale"] == "Need to confirm deployment correlation first"
        assert decision["decided_by"] == "Commander Chen"
        assert decision["supersedes_id"] is None
        assert decision["superseded_by_id"] is None

        h = await client.get(f"/api/incidents/{inc_id}/handoff")
        body = h.json()
        assert body["open_item_counts"]["active_decisions"] == 1
        active = body["sections"]["active_decisions"]
        assert len(active) == 1
        assert active[0]["value"] == "Hold rollback for 10 minutes"
        assert "Hold rollback for 10 minutes" in body["spoken_brief"]
        assert "Need to confirm deployment correlation first" in body["spoken_brief"]


@pytest.mark.asyncio
async def test_supersede_decision_keeps_chain_linked_and_hides_superseded_from_active():
    """
    The whole point of supersession: a handoff must never present a reversed
    decision as still current. Both ends of the chain must stay linked.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc = await client.post(
            "/api/incidents",
            json={"title": "Supersede Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc.json()["incident_id"]

        first = await client.post(
            f"/api/incidents/{inc_id}/decisions",
            json={
                "entity": "Rollback timing",
                "value": "Hold rollback for 10 minutes",
                "rationale": "Need to confirm deployment correlation first",
                "decided_by": "Commander Chen",
            },
        )
        old_id = first.json()["decision"]["id"]

        second = await client.post(
            f"/api/incidents/{inc_id}/decisions/{old_id}/supersede",
            json={
                "entity": "Rollback timing",
                "value": "Proceed with rollback now",
                "rationale": "Error rate correlation confirmed",
                "decided_by": "Commander Chen",
            },
        )
        assert second.status_code == 200
        new_decision = second.json()["decision"]
        assert new_decision["supersedes_id"] == old_id

        h = await client.get(f"/api/incidents/{inc_id}/handoff")
        body = h.json()

        # Only the new decision is active; the old one must not appear as current.
        assert body["open_item_counts"]["active_decisions"] == 1
        active_values = [d["value"] for d in body["sections"]["active_decisions"]]
        assert active_values == ["Proceed with rollback now"]

        superseded_ids = {d["claim_id"] for d in body["sections"]["superseded_decisions"]}
        assert old_id in superseded_ids

        assert "Proceed with rollback now" in body["spoken_brief"]
        assert "Hold rollback for 10 minutes" not in body["spoken_brief"]

        # Re-superseding the already-superseded decision must fail (409), not silently
        # create a second, competing "active" chain from the same stale decision.
        again = await client.post(
            f"/api/incidents/{inc_id}/decisions/{old_id}/supersede",
            json={
                "entity": "Rollback timing",
                "value": "Something else",
                "rationale": "irrelevant",
                "decided_by": "Commander Chen",
            },
        )
        assert again.status_code == 409


@pytest.mark.asyncio
async def test_supersede_nonexistent_decision_returns_404():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc = await client.post(
            "/api/incidents",
            json={"title": "Supersede 404 Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc.json()["incident_id"]

        r = await client.post(
            f"/api/incidents/{inc_id}/decisions/clm-nope/supersede",
            json={
                "entity": "X",
                "value": "Y",
                "rationale": "Z",
                "decided_by": "Commander Chen",
            },
        )
        assert r.status_code == 404
