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
async def test_generate_agora_rtm_token(monkeypatch):
    """RTM token endpoint (see docs/agora/RESEARCH.md §5) issues a token distinct
    from the RTC one, scoped to a user_account rather than a channel+uid."""
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_for_testing_00000000")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_certificate_for_testing_0000")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/agora/rtm-token",
            json={"user_account": "tocsin-viewer-1", "expire_seconds": 1800},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "token" in data
        assert data["app_id"] == "mock_app_id_for_testing_00000000"
        assert data["user_account"] == "tocsin-viewer-1"
        assert data["expires_in_seconds"] == 1800


@pytest.mark.asyncio
async def test_generate_agora_rtm_token_blocked_when_credentials_missing(monkeypatch):
    monkeypatch.delenv("AGORA_APP_ID", raising=False)
    monkeypatch.delenv("AGORA_APP_CERTIFICATE", raising=False)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/agora/rtm-token",
            json={"user_account": "tocsin-viewer-1"},
        )
        assert resp.status_code == 500


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
async def test_speak_broadcasts_via_active_agent(monkeypatch):
    """
    /api/agora/speak (item 4) must call Agora's documented
    POST /v2/projects/{appid}/agents/{agentId}/speak with the exact field names
    (text/priority/interruptable) against the agent_id tracked for that channel.
    """
    from app.api import agora as agora_module

    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.setitem(agora_module.ACTIVE_AGENTS, "speak_test_room", "agent_speak_1")

    mock_agora_response = Response(
        status_code=200,
        json={"agent_id": "agent_speak_1", "channel": "speak_test_room", "start_ts": 1234567890},
    )
    mock_client_instance = AsyncMock()
    mock_client_instance.post.return_value = mock_agora_response
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=mock_client_instance):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as test_client:
            resp = await test_client.post(
                "/api/agora/speak",
                json={
                    "channel_name": "speak_test_room",
                    "text": "Handoff brief: two open action items, one overdue.",
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "spoken"
            assert data["agent_id"] == "agent_speak_1"

            sent_url = mock_client_instance.post.call_args.args[0]
            assert sent_url == (
                "https://api.agora.io/api/conversational-ai-agent/v2/projects/"
                "mock_app_id_1234567890123456789012/agents/agent_speak_1/speak"
            )
            sent_payload = mock_client_instance.post.call_args.kwargs["json"]
            assert sent_payload == {
                "text": "Handoff brief: two open action items, one overdue.",
                "priority": "INTERRUPT",
                "interruptable": True,
            }


@pytest.mark.asyncio
async def test_speak_returns_404_when_no_active_agent(monkeypatch):
    """Speaking into a channel with no tracked agent must fail clearly, not silently."""
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        resp = await test_client.post(
            "/api/agora/speak",
            json={"channel_name": "no_agent_here_room", "text": "Hello"},
        )
        assert resp.status_code == 404


@pytest.mark.asyncio
async def test_agent_update_pushes_new_system_prompt(monkeypatch):
    """
    /api/agora/agent-update must call Agora's documented
    POST /v2/projects/{appid}/agents/{agentId}/update with the confirmed
    properties.llm.system_messages shape (see docs/agora/RESEARCH.md §13).
    """
    from app.api import agora as agora_module

    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.setitem(agora_module.ACTIVE_AGENTS, "update_test_room", "agent_update_1")

    mock_agora_response = Response(
        status_code=200,
        json={"agent_id": "agent_update_1", "create_ts": 1234567890, "status": "RUNNING"},
    )
    mock_client_instance = AsyncMock()
    mock_client_instance.post.return_value = mock_agora_response
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=mock_client_instance):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as test_client:
            resp = await test_client.post(
                "/api/agora/agent-update",
                json={
                    "channel_name": "update_test_room",
                    "system_prompt": "A new conflict was just detected: mention it.",
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "updated"
            assert data["agent_id"] == "agent_update_1"

            sent_url = mock_client_instance.post.call_args.args[0]
            assert sent_url == (
                "https://api.agora.io/api/conversational-ai-agent/v2/projects/"
                "mock_app_id_1234567890123456789012/agents/agent_update_1/update"
            )
            sent_payload = mock_client_instance.post.call_args.kwargs["json"]
            assert sent_payload == {
                "properties": {
                    "llm": {
                        "system_messages": [
                            {"role": "system", "content": "A new conflict was just detected: mention it."}
                        ],
                    },
                },
            }


@pytest.mark.asyncio
async def test_agent_update_returns_404_when_no_active_agent(monkeypatch):
    """Updating a channel with no tracked agent must fail clearly, not silently."""
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        resp = await test_client.post(
            "/api/agora/agent-update",
            json={"channel_name": "no_agent_here_room", "system_prompt": "Hello"},
        )
        assert resp.status_code == 404


@pytest.mark.asyncio
async def test_agent_think_injects_instruction(monkeypatch):
    """
    /api/agora/agent-think must call Agora's documented
    POST /v2/projects/{appid}/agents/{agentId}/think with the confirmed
    text/on_listening_action/on_thinking_action/on_speaking_action/interruptable
    shape (see docs/agora/RESEARCH.md §13).
    """
    from app.api import agora as agora_module

    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.setitem(agora_module.ACTIVE_AGENTS, "think_test_room", "agent_think_1")

    mock_agora_response = Response(
        status_code=200,
        json={"agent_id": "agent_think_1", "channel": "think_test_room", "start_ts": 1234567890},
    )
    mock_client_instance = AsyncMock()
    mock_client_instance.post.return_value = mock_agora_response
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=mock_client_instance):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as test_client:
            resp = await test_client.post(
                "/api/agora/agent-think",
                json={
                    "channel_name": "think_test_room",
                    "text": "A new conflict was just detected. Mention this to the room.",
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "injected"
            assert data["agent_id"] == "agent_think_1"

            sent_url = mock_client_instance.post.call_args.args[0]
            assert sent_url == (
                "https://api.agora.io/api/conversational-ai-agent/v2/projects/"
                "mock_app_id_1234567890123456789012/agents/agent_think_1/think"
            )
            sent_payload = mock_client_instance.post.call_args.kwargs["json"]
            assert sent_payload == {
                "text": "A new conflict was just detected. Mention this to the room.",
                "on_listening_action": "inject",
                "on_thinking_action": "interrupt",
                "on_speaking_action": "interrupt",
                "interruptable": True,
            }


@pytest.mark.asyncio
async def test_agent_think_returns_404_when_no_active_agent(monkeypatch):
    """Injecting an instruction into a channel with no tracked agent must fail clearly."""
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        resp = await test_client.post(
            "/api/agora/agent-think",
            json={"channel_name": "no_agent_here_room", "text": "Hello"},
        )
        assert resp.status_code == 404


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
            # RTM transcript delivery (see docs/agora/RESEARCH.md §5) is wired on
            # every pipeline, gemini_live included -- it is the transport, not a
            # pipeline-specific feature.
            assert sent_payload["properties"]["advanced_features"]["enable_rtm"] is True
            assert sent_payload["properties"]["parameters"] == {"data_channel": "rtm"}


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
            # Confirmed against a live HTTP 400 from Agora's real join API on
            # 2026-08-31 ("Invalid value at properties.asr.params.url: required
            # field is missing") -- managed credential_mode does not imply the
            # endpoint URL is implied, only that Agora supplies the API key.
            assert props["asr"]["params"]["url"] == "wss://api.deepgram.com/v1/listen"

            assert props["llm"]["vendor"] == "custom"
            assert props["llm"]["style"] == "gemini"
            assert "mock_gemini_api_key" in props["llm"]["url"] or props["llm"]["api_key"] == "mock_gemini_api_key"
            # composed_tools must NOT default to the gemini_live-only Live model --
            # confirmed live 2026-08-31: calling gemini-3.1-flash-live-preview via
            # the plain streamGenerateContent REST endpoint (what composed_tools
            # actually uses) returns HTTP 400 "only supports real-time
            # bidirectional streaming via WebSocket". This is why the two
            # pipelines have separate model fields (model vs
            # composed_tools_llm_model) instead of sharing one.
            assert props["llm"]["params"]["model"] == "gemini-3.6-flash"
            assert "live" not in props["llm"]["params"]["model"]
            assert "live" not in props["llm"]["url"]
            assert props["llm"]["mcp_servers"] == [
                {
                    "name": "tocsin-emergency-tools",
                    "endpoint": "https://example.com/mcp/sse",
                    "transport": "sse",
                }
            ]

            assert props["tts"]["vendor"] == "minimax"
            assert props["tts"]["credential_mode"] == "managed"
            # Same finding as the asr assertion above, confirmed against a live
            # HTTP 400 for properties.tts.params.url on the same live test.
            assert props["tts"]["params"]["url"] == "wss://api.minimax.io/ws/v1/t2a_v2"

            assert props["advanced_features"]["enable_tools"] is True
            assert props["advanced_features"]["enable_rtm"] is True
            assert props["parameters"] == {"data_channel": "rtm"}

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
            assert "enable_tools" not in sent_payload["properties"]["advanced_features"]
            # RTM transcript delivery is unconditional (see docs/agora/RESEARCH.md §5),
            # independent of whether MCP tools were requested.
            assert sent_payload["properties"]["advanced_features"]["enable_rtm"] is True
            assert sent_payload["properties"]["parameters"] == {"data_channel": "rtm"}
