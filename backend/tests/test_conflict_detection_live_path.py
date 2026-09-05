"""
Contradiction detection through the real ingestion path.

Zero conflicts were recorded across ALL THREE live runs of 2026-09-05 —
including one with 18 LLM-extracted claims — despite CLAUDE.md's canonical
scenario being built around a contradiction, and despite the agent catching that
contradiction out loud in the voice channel.

Two structural causes, both fixed:

1. `ClaimRepository.find_by_entity` selected candidates with `entity = $2`,
   exact SQL string equality. Every fuzzy subject matcher in
   `conflict_detector._entities_match` therefore only ever ran on pairs that
   were already byte-identical: 'authentication database' vs 'database cpu'
   never reached the comparison. The matcher was not wrong, it was unreachable.

2. `detect_conflicts` skipped any pair sharing a source AND a speaker. In a
   single-operator voice room that is every pair.

The negative controls matter as much as the positive one. CLAUDE.md names
cry-wolf as the failure that destroys trust in the tool, so widening the
candidate set is only safe if unrelated entities and complementary readings
still produce nothing.
"""

import pytest
from httpx import ASGITransport, AsyncClient

from app.engine.conflict_detector import detect_conflicts
from app.main import app


# ── Unit level: the matcher, now that it is actually reachable ───────────────


def _claim(cid, entity, value, speaker="Operator", source="voice_transcript"):
    return {
        "id": cid,
        "entity": entity,
        "value": value,
        "speaker": speaker,
        "source": source,
        "timestamp": None,
    }


def test_the_canonical_contradiction_is_detected():
    """
    CLAUDE.md's scenario, lines 3 and 4: engineering suspects the auth database
    is overloaded; SRE reports database CPU is normal. Different entity strings,
    same subject.
    """
    conflicts = detect_conflicts(
        new_entity="database cpu",
        new_value="normal",
        new_claim_id="clm-new",
        new_source="voice_transcript",
        new_speaker="Operator",
        existing_claims=[_claim("clm-old", "authentication database", "overloaded")],
    )
    assert len(conflicts) == 1, "the product's own headline contradiction must be caught"
    assert conflicts[0]["claim_a_id"] == "clm-old"


def test_one_speaker_relaying_two_sources_still_conflicts():
    """
    The incident commander voices both sides. Previously skipped outright
    because speaker and source matched — which in a voice room is always true.
    """
    conflicts = detect_conflicts(
        new_entity="login api",
        new_value="healthy",
        new_claim_id="clm-b",
        new_source="voice_transcript",
        new_speaker="Operator",
        existing_claims=[_claim("clm-a", "login api", "down")],
    )
    assert len(conflicts) == 1


# ── Negative controls: widening must not mean crying wolf ────────────────────


def test_unrelated_entities_do_not_conflict():
    conflicts = detect_conflicts(
        new_entity="user database",
        new_value="healthy",
        new_claim_id="clm-b",
        new_source="voice_transcript",
        new_speaker="Operator",
        existing_claims=[_claim("clm-a", "payment database", "down")],
    )
    assert conflicts == [], "different subjects must not be forced into a conflict"


def test_complementary_readings_of_one_fault_do_not_conflict():
    """"503 errors" and "40% error rate" describe the same fault, not a dispute."""
    conflicts = detect_conflicts(
        new_entity="login api",
        new_value="40% error rate",
        new_claim_id="clm-b",
        new_source="voice_transcript",
        new_speaker="Operator",
        existing_claims=[_claim("clm-a", "login api", "503 errors")],
    )
    assert conflicts == []


def test_a_claim_never_conflicts_with_itself():
    conflicts = detect_conflicts(
        new_entity="login api",
        new_value="down",
        new_claim_id="clm-a",
        new_source="voice_transcript",
        new_speaker="Operator",
        existing_claims=[_claim("clm-a", "login api", "healthy")],
    )
    assert conflicts == []


def test_a_recovery_report_is_not_a_contradiction():
    """
    "The API is down" ... an hour later ... "the API is up" is a state change.
    Distinguished by elapsed time, which is what actually separates the two.
    """
    stale = _claim("clm-a", "login api", "down")
    stale["timestamp"] = "2020-01-01T00:00:00+00:00"
    conflicts = detect_conflicts(
        new_entity="login api",
        new_value="healthy",
        new_claim_id="clm-b",
        new_source="voice_transcript",
        new_speaker="Operator",
        existing_claims=[stale],
    )
    assert conflicts == [], "recovery must not be reported as a disagreement"


# ── End to end through the HTTP ingestion path ───────────────────────────────


@pytest.mark.asyncio
async def test_contradiction_surfaces_through_real_ingestion():
    """
    The proof that matters: two spoken lines, one operator, one voice channel —
    the exact shape of the live runs that recorded zero conflicts. Runs on the
    heuristic extractor, so it is independent of LLM quota.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc = await client.post(
            "/api/incidents",
            json={"title": "Contradiction Path Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc.json()["incident_id"]

        for utterance in [
            "The authentication database is overloaded and failing.",
            "The authentication database is healthy and running normally.",
        ]:
            res = await client.post(
                f"/api/incidents/{inc_id}/observations",
                json={
                    "raw_utterance": utterance,
                    "speaker": "Operator",
                    "source": "voice_transcript",
                },
            )
            assert res.status_code == 201

        state = (await client.get(f"/api/incidents/{inc_id}")).json()
        assert len(state["conflicts"]) >= 1, (
            "a contradiction voiced by one operator on one channel must reach the record; "
            f"claims were {[(c['entity'], c['value']) for c in state['claims']]}"
        )


@pytest.mark.asyncio
async def test_claudemd_canonical_pair_conflicts_on_the_heuristic_path():
    """
    CLAUDE.md's scenario lines 3 and 4, verbatim in shape: a hypothesis about the
    auth database being overloaded, then a report that it is healthy.

    Three separate things had to be true for this to work, and none of them were
    on 2026-09-05: the heuristic had to recognise "overloaded" as a health state
    at all (it did not); both utterances had to yield the SAME entity string
    ("the authentication database" vs "authentication database" would not match);
    and the candidate query had to return a claim from a different utterance by
    the same speaker on the same channel.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc = await client.post(
            "/api/incidents",
            json={"title": "Canonical Pair", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc.json()["incident_id"]

        for utterance in [
            "I suspect the authentication database is overloaded.",
            "SRE says the authentication database is healthy and running normally.",
        ]:
            await client.post(
                f"/api/incidents/{inc_id}/observations",
                json={
                    "raw_utterance": utterance,
                    "speaker": "Operator",
                    "source": "voice_transcript",
                },
            )

        state = (await client.get(f"/api/incidents/{inc_id}")).json()
        entities = [c["entity"] for c in state["claims"]]
        assert entities.count("authentication database") == 2, (
            f"both utterances must name the same entity, got {entities}"
        )
        assert len(state["conflicts"]) >= 1, "the canonical contradiction must be recorded"
        assert len(state["hypotheses"]) >= 1, "the suspicion must be filed as a hypothesis"
