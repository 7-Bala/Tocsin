"""
Gemini Extraction Verification Tests
Verifies:
1. Live Gemini LLM structured extraction when quota is available (extraction_method="llm").
2. Structured JSON response contains claims, decisions, action items, missing info, risks.
3. If GEMINI_API_KEY is missing OR quota is exhausted (HTTP 429), the engine gracefully falls back to
   extraction_method="heuristic_fallback" with evidence_status="UNVERIFIED" (never falsely claiming LLM or CONFIRMED).
"""

import os
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.engine.extraction import extract_intelligence


@pytest.mark.asyncio
async def test_live_gemini_extraction_or_graceful_quota_fallback():
    """Live test calling Gemini API: validates LLM extraction if quota available, or fallback if 429/empty."""
    utterance = "Ravi reports that the identity service is returning 500 errors to 30% of users, and I will verify database connection pools within 10 minutes."
    claim_set = await extract_intelligence(utterance, speaker="Ravi")

    assert claim_set.extraction_method in ("llm", "heuristic_fallback")
    assert len(claim_set.claims) >= 1
    assert any("identity" in c.entity.lower() or "service" in c.entity.lower() for c in claim_set.claims)

    if claim_set.extraction_method == "llm":
        # Full LLM extraction verification
        assert claim_set.category in ("REPORT", "ACTION_ITEM")
    else:
        # Graceful fallback verification: Must be UNVERIFIED/REPORTED, never CONFIRMED
        assert claim_set.evidence_status in ("REPORTED", "UNVERIFIED")
        assert claim_set.evidence_status != "CONFIRMED"


@pytest.mark.asyncio
async def test_fallback_when_gemini_key_missing(monkeypatch):
    """When GEMINI_API_KEY is empty, fallback extractor is strictly used and clearly labeled."""
    monkeypatch.setenv("GEMINI_API_KEY", "")

    utterance = "The main water pump is down and failing."
    claim_set = await extract_intelligence(utterance, speaker="Field Tech")

    assert claim_set.extraction_method == "heuristic_fallback"
    assert claim_set.evidence_status in ("REPORTED", "UNVERIFIED")
    assert claim_set.evidence_status != "CONFIRMED"
    assert len(claim_set.claims) >= 1
    assert "pump" in claim_set.claims[0].entity.lower()


@pytest.mark.asyncio
async def test_end_to_end_observation_ingestion_with_gemini_or_fallback():
    """Full HTTP endpoint test through /api/incidents/{id}/observations asserting honest method reporting."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Gemini Live Ingestion Test", "event_type": "TECHNICAL_INCIDENT"},
        )
        inc_id = inc_res.json()["incident_id"]

        obs_res = await client.post(
            f"/api/incidents/{inc_id}/observations",
            json={
                "raw_utterance": "We verified that the cooling system temperature exceeded 85 degrees.",
                "speaker": "Site Lead",
                "source": "voice_transcript",
            },
        )
        assert obs_res.status_code == 201
        data = obs_res.json()
        assert data["extraction_method"] in ("llm", "heuristic_fallback")
        assert data["claims_extracted"] >= 1


@pytest.mark.asyncio
async def test_gemini_call_that_exceeds_timeout_falls_back_cleanly(monkeypatch):
    """
    Regression test for a live-observed defect (2026-08-31): a single Gemini call took
    173 seconds with no error, because the SDK call had no timeout — the entire
    observation-ingestion request (and therefore any chat feature built on it) hung
    indefinitely instead of failing over to the heuristic fallback.

    This simulates that condition deterministically: monkeypatch the timeout ceiling to
    a tiny value and make the mocked SDK call sleep longer than it, then assert
    extraction still returns promptly via the heuristic fallback rather than hanging.
    """
    import asyncio
    from unittest.mock import AsyncMock, MagicMock, patch

    import app.engine.extraction as extraction_module

    monkeypatch.setenv("GEMINI_API_KEY", "fake-key-for-timeout-test")
    monkeypatch.setattr(extraction_module, "EXTRACTION_TIMEOUT_SECONDS", 0.2)

    async def _hangs_forever(*args, **kwargs):
        await asyncio.sleep(5.0)  # far longer than the 0.2s timeout above
        raise AssertionError("should have been cancelled by asyncio.wait_for before this ran")

    mock_models = MagicMock()
    mock_models.generate_content = AsyncMock(side_effect=_hangs_forever)
    mock_client = MagicMock()
    mock_client.aio.models = mock_models

    with patch("google.genai.Client", return_value=mock_client):
        start = asyncio.get_event_loop().time()
        claim_set = await extraction_module.extract_intelligence(
            "The identity service is down.", speaker="Test"
        )
        elapsed = asyncio.get_event_loop().time() - start

    # Must return quickly (bounded by the timeout, not the simulated 5s hang) and must
    # fall back — never silently produce llm-labeled output from a call that never
    # actually completed.
    assert elapsed < 2.0, f"extraction took {elapsed:.2f}s — timeout did not cut off the hang"
    assert claim_set.extraction_method == "heuristic_fallback"
    assert claim_set.evidence_status != "CONFIRMED"
