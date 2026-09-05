"""
Regression suite for the 2026-09-05 Scenario B fragment flood.

Live run `room-202609051125-3zuj4` recorded **115 observations for roughly 10
spoken sentences**. Agora's TRANSCRIPT_UPDATED stream delivers each sentence as
a series of growing partials, every one of which was ingested as its own
complete observation, extracted into its own claim, and charged its own LLM
call — which is what exhausted a full day of both Gemini and Groq quota.

The client-side `TurnSettler` is the primary defence. These tests cover the
server-side backstops: a minimum-substance floor and one-directional prefix
deduplication.

The controlling risk here is over-filtering, not under-filtering. On 2026-09-04 a
too-aggressive guard elsewhere in this pipeline caused a full six-line script to
produce *zero* observations. So every test below that asserts something is
dropped is paired with one asserting that real speech survives.
"""

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


async def _new_incident(client: AsyncClient) -> str:
    res = await client.post(
        "/api/incidents",
        json={"title": "Fragment Gate Test", "event_type": "TECHNICAL_INCIDENT"},
    )
    return res.json()["incident_id"]


async def _ingest(client: AsyncClient, inc_id: str, text: str, speaker: str = "Operator"):
    return await client.post(
        f"/api/incidents/{inc_id}/observations",
        json={"raw_utterance": text, "speaker": speaker, "source": "voice_transcript"},
    )


@pytest.mark.asyncio
async def test_single_word_fragments_are_rejected_before_extraction():
    """
    These five are verbatim from the failing run's observations table. Each one
    became a real row, and each one cost an LLM call.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_id = await _new_incident(client)

        for fragment in ["Customers", "Platform", "Next,", "Let's", "Standing"]:
            res = await _ingest(client, inc_id, fragment)
            body = res.json()
            assert body.get("skipped") is True, f"{fragment!r} should not become evidence"
            assert body["reason"] == "below_minimum_substance"

        state = (await client.get(f"/api/incidents/{inc_id}")).json()
        assert len(state["observations"]) == 0


@pytest.mark.asyncio
async def test_short_real_commands_still_survive_the_substance_floor():
    """
    The floor is 2 words precisely so genuine two-word commands live. This is the
    guard against repeating the 2026-09-04 zero-observation regression.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_id = await _new_incident(client)

        for utterance in ["Rollback approved", "Page the on-call engineer", "Login API is down"]:
            res = await _ingest(client, inc_id, utterance)
            assert res.status_code == 201, f"{utterance!r} must be recorded"
            assert res.json().get("skipped") is not True

        state = (await client.get(f"/api/incidents/{inc_id}")).json()
        assert len(state["observations"]) == 3


@pytest.mark.asyncio
async def test_redelivered_partial_is_dropped_once_the_full_sentence_is_recorded():
    """
    TRANSCRIPT_UPDATED resends the full history on every emission, so a partial
    can arrive *after* its own complete form — on a client reconnect, or when a
    new settler instance replays the turn.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_id = await _new_incident(client)

        full = "Customers can't place orders at all, every request returns a 500."
        assert (await _ingest(client, inc_id, full)).status_code == 201

        replay = await _ingest(client, inc_id, "Customers can't place orders")
        assert replay.json().get("skipped") is True
        assert replay.json()["reason"] == "superseded_partial_transcript"

        state = (await client.get(f"/api/incidents/{inc_id}")).json()
        assert len(state["observations"]) == 1


@pytest.mark.asyncio
async def test_an_extension_is_never_dropped():
    """
    Strictly one-directional. Dropping the longer form would leave a truncated
    sentence as the permanent record — losing evidence, which is the worse
    failure of the two.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_id = await _new_incident(client)

        await _ingest(client, inc_id, "The database CPU looks normal")
        extended = await _ingest(
            client, inc_id, "The database CPU looks normal and connection usage is healthy"
        )
        assert extended.status_code == 201
        assert extended.json().get("skipped") is not True


@pytest.mark.asyncio
async def test_different_speakers_do_not_suppress_each_other():
    """
    Two people can legitimately open with the same words. Prefix dedup is scoped
    per speaker so one never silences the other.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_id = await _new_incident(client)

        await _ingest(client, inc_id, "The login API is failing badly right now", speaker="Dave")
        second = await _ingest(client, inc_id, "The login API is failing", speaker="Priya")
        assert second.status_code == 201
        assert second.json().get("skipped") is not True
