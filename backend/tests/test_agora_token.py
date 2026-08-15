"""
Tests for Agora Token Generation & Agent Endpoint
"""

from unittest.mock import AsyncMock, patch
from httpx import ASGITransport, AsyncClient, Response
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
async def test_start_agent_blocked_when_credentials_missing(monkeypatch):
    """Test that start-agent endpoint cleanly blocks and returns 503 when customer credentials are unset."""
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_cert_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "")
    monkeypatch.setenv("GEMINI_API_KEY", "")

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


@pytest.mark.asyncio
async def test_start_agent_success_mocked(monkeypatch):
    """Test that start-agent formats payload correctly and returns agent metadata without leaking secrets."""
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_cert_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")

    mock_agora_response = Response(
        status_code=200,
        json={"agent_id": "agent_session_abc123", "status": "idle"},
    )

    mock_client_instance = AsyncMock()
    mock_client_instance.post.return_value = mock_agora_response
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=mock_client_instance):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as test_client:
            resp = await test_client.post(
                "/api/agora/start-agent",
                json={
                    "channel_name": "emergency_test_room",
                    "agent_uid": 9999,
                    "voice": "Puck",
                },
            )

            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "started"
            assert data["agent_id"] == "agent_session_abc123"
            assert data["channel_name"] == "emergency_test_room"
            assert data["agent_uid"] == 9999
            assert data["mllm_provider"] == "gemini"

            # Strict security assertion: zero secrets returned in response
            assert "mock_cert" not in str(data)
            assert "mock_customer_secret" not in str(data)
            assert "mock_gemini_api_key" not in str(data)


@pytest.mark.asyncio
async def test_stop_agent_success_mocked(monkeypatch):
    """Test stopping an active agent session."""
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")

    mock_agora_response = Response(status_code=200, json={})

    mock_client_instance = AsyncMock()
    mock_client_instance.post.return_value = mock_agora_response
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=mock_client_instance):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as test_client:
            resp = await test_client.post(
                "/api/agora/stop-agent",
                json={
                    "channel_name": "emergency_test_room",
                    "agent_id": "agent_session_abc123",
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "stopped"
            assert data["agent_id"] == "agent_session_abc123"
