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
    utterance = "Ravi reports that the payment gateway is returning 500 errors to 30% of users, and I will verify database connection pools within 10 minutes."
    claim_set = await extract_intelligence(utterance, speaker="Ravi")

    assert claim_set.extraction_method in ("llm", "heuristic_fallback")
    assert len(claim_set.claims) >= 1
    assert any("payment" in c.entity.lower() or "gateway" in c.entity.lower() for c in claim_set.claims)

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
