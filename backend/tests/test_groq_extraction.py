"""
Groq Extraction Tier Tests
Verifies:
1. Groq is skipped entirely (falls through to Gemini/heuristic) when GROQ_API_KEY is unset.
2. A successful Groq structured-output response is parsed into a ClaimSet labeled "llm".
3. A non-200 Groq response falls through to Gemini/heuristic rather than raising.
4. A Groq call that exceeds its timeout falls back cleanly rather than hanging --
   mirrors the same live-observed Gemini defect (173s hang) this project already
   guards against; Groq gets the identical protection.
5. extract_intelligence() only tries Groq as a fallback when Gemini fails/is
   unconfigured -- Gemini stays primary, Groq is not tried first even when both
   keys are set.
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.engine import extraction as extraction_module
from app.engine.extraction import extract_intelligence, extract_with_groq


def _mock_groq_response(status_code: int, body: dict | None = None, json_content: dict | None = None):
    mock_response = MagicMock()
    mock_response.status_code = status_code
    mock_response.text = json.dumps(body) if body else ""
    if json_content is not None:
        mock_response.json.return_value = {
            "choices": [{"message": {"content": json.dumps(json_content)}}]
        }
    return mock_response


def _mock_async_client(mock_response):
    mock_client_instance = AsyncMock()
    mock_client_instance.post.return_value = mock_response
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.__aexit__.return_value = None
    return mock_client_instance


@pytest.mark.asyncio
async def test_groq_skipped_when_key_missing(monkeypatch):
    """No GROQ_API_KEY set -> extract_with_groq returns None without making any HTTP call."""
    monkeypatch.setenv("GROQ_API_KEY", "")
    result = await extract_with_groq("The login API is down.", speaker="Ops")
    assert result is None


@pytest.mark.asyncio
async def test_groq_successful_extraction_labeled_llm(monkeypatch):
    """A valid Groq structured-output response parses into a ClaimSet with extraction_method='llm'."""
    monkeypatch.setenv("GROQ_API_KEY", "fake-groq-key")

    claim_payload = {
        "category": "REPORT",
        "content": "The identity service is returning errors.",
        "confidence": 0.9,
        "evidence_status": "REPORTED",
        "claims": [
            {"claim_type": "system_health", "entity": "identity service", "value": "failing", "confidence": 0.9}
        ],
        "action_items": [],
        "missing_info": [],
        "risks": [],
        "decisions": [],
    }
    mock_response = _mock_groq_response(200, json_content=claim_payload)

    with patch("app.engine.extraction.httpx.AsyncClient", return_value=_mock_async_client(mock_response)):
        result = await extract_with_groq("The identity service is failing.", speaker="Ops")

    assert result is not None
    assert result.extraction_method == "llm"
    assert result.category == "REPORT"
    assert len(result.claims) == 1
    assert result.claims[0].entity == "identity service"


@pytest.mark.asyncio
async def test_groq_non_200_falls_through(monkeypatch):
    """A Groq error response returns None rather than raising, so the caller can fall through."""
    monkeypatch.setenv("GROQ_API_KEY", "fake-groq-key")
    mock_response = _mock_groq_response(429, body={"error": "rate limited"})

    with patch("app.engine.extraction.httpx.AsyncClient", return_value=_mock_async_client(mock_response)):
        result = await extract_with_groq("The identity service is failing.", speaker="Ops")

    assert result is None


@pytest.mark.asyncio
async def test_groq_timeout_falls_back_cleanly(monkeypatch):
    """
    Same class of defect this project already fixed for Gemini (173s hang, see
    test_gemini_call_that_exceeds_timeout_falls_back_cleanly): a Groq call that
    exceeds its timeout must return promptly, not hang indefinitely.
    """
    import httpx

    monkeypatch.setenv("GROQ_API_KEY", "fake-groq-key")
    monkeypatch.setattr(extraction_module, "GROQ_EXTRACTION_TIMEOUT_SECONDS", 0.2)

    mock_client_instance = AsyncMock()
    mock_client_instance.post.side_effect = httpx.TimeoutException("simulated timeout")
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.__aexit__.return_value = None

    with patch("app.engine.extraction.httpx.AsyncClient", return_value=mock_client_instance):
        start = asyncio.get_event_loop().time()
        result = await extract_with_groq("The identity service is failing.", speaker="Ops")
        elapsed = asyncio.get_event_loop().time() - start

    assert result is None
    assert elapsed < 2.0


@pytest.mark.asyncio
async def test_extract_intelligence_tries_gemini_before_groq(monkeypatch):
    """
    Gemini stays primary: when both GROQ_API_KEY and GEMINI_API_KEY are set and
    Gemini succeeds, Groq must not be called at all.
    """
    monkeypatch.setenv("GROQ_API_KEY", "fake-groq-key")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-gemini-key")

    from app.engine.extraction import ClaimSet

    gemini_result = ClaimSet(
        category="REPORT",
        content="Gemini handled this.",
        confidence=0.9,
        evidence_status="REPORTED",
        extraction_method="llm",
        claims=[],
        action_items=[],
        missing_info=[],
        risks=[],
        decisions=[],
    )
    gemini_call = AsyncMock(return_value=gemini_result)
    groq_call = AsyncMock(side_effect=AssertionError("Groq should not have been called"))

    with patch("app.engine.extraction.extract_with_gemini", gemini_call), \
         patch("app.engine.extraction.extract_with_groq", groq_call):
        result = await extract_intelligence("The main pump is failing.", speaker="Field Tech")

    assert result.extraction_method == "llm"
    assert result.content == "Gemini handled this."
    groq_call.assert_not_called()


@pytest.mark.asyncio
async def test_extract_intelligence_falls_back_to_groq_when_gemini_fails(monkeypatch):
    """
    The actual user-requested behavior: when Gemini fails (e.g. its quota is
    exhausted -- extract_with_gemini() returns None for any failure, quota
    included), Groq is tried next, before falling all the way to heuristics.
    """
    monkeypatch.setenv("GROQ_API_KEY", "fake-groq-key")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-gemini-key")

    claim_payload = {
        "category": "REPORT",
        "content": "Groq handled this after Gemini failed.",
        "confidence": 0.9,
        "evidence_status": "REPORTED",
        "claims": [{"claim_type": "system_health", "entity": "pump", "value": "failing", "confidence": 0.9}],
        "action_items": [],
        "missing_info": [],
        "risks": [],
        "decisions": [],
    }
    mock_response = _mock_groq_response(200, json_content=claim_payload)
    gemini_call = AsyncMock(return_value=None)  # simulates quota exhaustion / any Gemini failure

    with patch("app.engine.extraction.extract_with_gemini", gemini_call), \
         patch("app.engine.extraction.httpx.AsyncClient", return_value=_mock_async_client(mock_response)):
        result = await extract_intelligence("The main pump is failing.", speaker="Field Tech")

    assert result.extraction_method == "llm"
    assert result.content == "Groq handled this after Gemini failed."
    gemini_call.assert_called_once()


@pytest.mark.asyncio
async def test_extract_intelligence_reaches_heuristic_when_neither_key_set(monkeypatch):
    """With neither GEMINI_API_KEY nor GROQ_API_KEY set, both LLM tiers are skipped."""
    monkeypatch.setenv("GROQ_API_KEY", "")
    monkeypatch.setenv("GEMINI_API_KEY", "")

    result = await extract_intelligence("The main pump is down and failing.", speaker="Field Tech")

    assert result.extraction_method == "heuristic_fallback"
