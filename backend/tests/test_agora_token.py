"""
Tests for Agora Token Generation & Agent Endpoint
"""

from httpx import ASGITransport, AsyncClient
import pytest

from app.main import app


@pytest.mark.asyncio
async def test_generate_agora_rtc_token_numeric_uid(monkeypatch):
    """Test generating a valid Agora RTC token for numeric UID."""
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_for_testing_00000000")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_certificate_for_testing_0000")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/agora/token",
            json={
                "channel_name": "emergency_test_channel_01",
                "uid": 12345,
                "role": "publisher",
                "expire_seconds": 3600,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "token" in data
        assert data["token"].startswith("006mock_app_id_for_testing_00000000")
        assert data["app_id"] == "mock_app_id_for_testing_00000000"
        assert data["channel_name"] == "emergency_test_channel_01"
        assert data["uid"] == 12345
        assert data["expires_in_seconds"] == 3600
        # Ensure certificate is NEVER returned
        assert "app_certificate" not in data


@pytest.mark.asyncio
async def test_generate_agora_rtc_token_string_account(monkeypatch):
    """Test generating a valid Agora RTC token for string account."""
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_for_testing_00000000")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_certificate_for_testing_0000")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/agora/token",
            json={
                "channel_name": "emergency-responder-channel",
                "uid": "responder-alpha-9",
                "role": "subscriber",
                "expire_seconds": 1800,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "token" in data
        assert data["uid"] == "responder-alpha-9"


@pytest.mark.asyncio
async def test_generate_agora_rtc_token_invalid_channel_name():
    """Test rejection of malformed or dangerous channel names."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/agora/token",
            json={
                "channel_name": "bad/channel$name!@#",
                "uid": 12345,
            },
        )
        assert resp.status_code == 400


@pytest.mark.asyncio
async def test_start_agent_substep_3_blocked_when_credentials_missing(monkeypatch):
    """Test that start-agent endpoint cleanly blocks and returns 503 when customer credentials are unset."""
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/agora/start-agent",
            json={
                "channel_name": "emergency_test_channel_01",
                "agent_uid": 9999,
            },
        )
        assert resp.status_code == 503
        assert "AGORA_CUSTOMER_ID" in resp.json()["detail"]
