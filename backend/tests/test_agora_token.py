"""
Tests for Agora Token Generation & Agent Endpoint
"""

from unittest.mock import AsyncMock, patch

import pytest
from app.main import app
from httpx import ASGITransport, AsyncClient, Response


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
    # Explicitly cleared: this test asserts NOT_REQUESTED, which only holds if no MCP
    # server URL leaks in from the real dev .env's MCP_SERVER_PUBLIC_URL.
    monkeypatch.delenv("MCP_SERVER_PUBLIC_URL", raising=False)

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
            assert data["llm_provider"] == "gemini"
            assert data["voice_pipeline"] == "gemini_live"
            assert data["mcp_tool_calling_status"] == "NOT_REQUESTED"

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


@pytest.mark.asyncio
async def test_gemini_live_pipeline_never_sends_mcp_servers_even_when_requested(monkeypatch):
    """
    Regression test for the confirmed-wrong wiring: even if a caller asks for
    voice_pipeline='gemini_live' (the default) AND supplies an mcp_server_url, the
    outbound payload must never carry mcp_servers under mllm -- official Agora docs
    do not support it there. mcp_enabled/mcp_tool_calling_status must say so honestly.
    """
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_cert_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")

    mock_agora_response = Response(status_code=200, json={"agent_id": "agent_gl_1"})
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
                    "channel_name": "gemini_live_room",
                    "agent_uid": 9999,
                    "voice_pipeline": "gemini_live",
                    "mcp_server_url": "https://example.com/mcp",
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["voice_pipeline"] == "gemini_live"
            assert data["mcp_enabled"] is False
            assert "NOT_SUPPORTED" in data["mcp_tool_calling_status"]

            sent_payload = mock_client_instance.post.call_args.kwargs["json"]
            assert "mllm" in sent_payload["properties"]
            assert "mcp_servers" not in sent_payload["properties"]["mllm"]
            assert "llm" not in sent_payload["properties"]
            assert "asr" not in sent_payload["properties"]
            assert "tts" not in sent_payload["properties"]


@pytest.mark.asyncio
async def test_composed_tools_pipeline_wires_mcp_servers_under_llm(monkeypatch):
    """
    voice_pipeline='composed_tools' must build the documented asr+llm+tts shape, with
    mcp_servers under `llm` (not `mllm`) and advanced_features.enable_tools set --
    matching docs.agora.io/en/api-reference/api-ref/conversational-ai/join.
    """
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_cert_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")

    mock_agora_response = Response(status_code=200, json={"agent_id": "agent_ct_1"})
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
                    "channel_name": "composed_tools_room",
                    "agent_uid": 9999,
                    "voice_pipeline": "composed_tools",
                    "mcp_server_url": "https://example.com/mcp",
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["voice_pipeline"] == "composed_tools"
            assert data["mcp_enabled"] is True
            assert data["mcp_server_url"] == "https://example.com/mcp/sse"
            assert "WIRED PER OFFICIAL DOCS" in data["mcp_tool_calling_status"]
            assert "NOT YET LIVE-VERIFIED" in data["mcp_tool_calling_status"]

            sent_payload = mock_client_instance.post.call_args.kwargs["json"]
            props = sent_payload["properties"]
            assert "mllm" not in props

            assert props["asr"]["vendor"] == "deepgram"
            assert props["asr"]["credential_mode"] == "managed"

            assert props["llm"]["vendor"] == "custom"
            assert props["llm"]["style"] == "gemini"
            assert "mock_gemini_api_key" in props["llm"]["url"] or props["llm"]["api_key"] == "mock_gemini_api_key"
            assert props["llm"]["mcp_servers"] == [
                {
                    "name": "tocsin-emergency-tools",
                    "endpoint": "https://example.com/mcp/sse",
                    "transport": "sse",
                }
            ]

            assert props["tts"]["vendor"] == "minimax"
            assert props["tts"]["credential_mode"] == "managed"

            assert props["advanced_features"] == {"enable_tools": True}

            # No secrets leaked into the app's own logs via sanitize_payload.
            from app.api.agora import sanitize_payload

            sanitized = sanitize_payload(sent_payload)
            assert "mock_gemini_api_key" not in str(sanitized)


@pytest.mark.asyncio
async def test_composed_tools_without_mcp_url_omits_mcp_servers(monkeypatch):
    """composed_tools with no MCP server configured must not fabricate a tool server."""
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_cert_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")
    monkeypatch.delenv("MCP_SERVER_PUBLIC_URL", raising=False)

    mock_agora_response = Response(status_code=200, json={"agent_id": "agent_ct_2"})
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
                    "channel_name": "composed_tools_no_mcp",
                    "agent_uid": 9999,
                    "voice_pipeline": "composed_tools",
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["mcp_enabled"] is False
            assert data["mcp_tool_calling_status"] == "NOT_REQUESTED"

            sent_payload = mock_client_instance.post.call_args.kwargs["json"]
            assert "mcp_servers" not in sent_payload["properties"]["llm"]
            assert "advanced_features" not in sent_payload["properties"]
