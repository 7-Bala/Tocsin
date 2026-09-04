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


def _mock_list_agents_response(agent_ids):
    """Mocks Agora's GET /agents?channel=&state=2 (running-agent list) response."""
    return Response(
        status_code=200,
        json={
            "data": {"count": len(agent_ids), "list": [{"agent_id": a, "status": "RUNNING"} for a in agent_ids]},
            "meta": {"cursor": "", "total": len(agent_ids)},
            "status": "ok",
        },
    )


@pytest.mark.asyncio
async def test_start_agent_does_not_start_a_duplicate_when_one_is_already_running(monkeypatch):
    """
    Regression test for the live-reported "two greetings" bug (2026-09-02): the user
    heard one greeting on unmute (an agent already in the channel) and a second after
    pressing Start Agent, because this endpoint started a duplicate unconditionally --
    leaving two agents in one room, both greeting and both billing.

    Now: if Agora reports an agent already RUNNING in the channel, return it instead
    of POSTing a second /join.
    """
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_cert_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")

    mock_client_instance = AsyncMock()
    mock_client_instance.get.return_value = _mock_list_agents_response(["agent_already_live"])
    mock_client_instance.post.side_effect = AssertionError(
        "start-agent must NOT POST /join when an agent is already running"
    )
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=mock_client_instance):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as test_client:
            resp = await test_client.post(
                "/api/agora/start-agent",
                json={"channel_name": "dup_guard_room", "agent_uid": 9999},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "already_running"
            assert data["agent_id"] == "agent_already_live"
            assert data["reused_existing_agent"] is True


@pytest.mark.asyncio
async def test_start_agent_force_restart_stops_existing_then_starts_new(monkeypatch):
    """force_restart=true must stop the already-running agent before starting a fresh one."""
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_cert_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")
    monkeypatch.delenv("MCP_SERVER_PUBLIC_URL", raising=False)

    mock_client_instance = AsyncMock()
    mock_client_instance.get.return_value = _mock_list_agents_response(["agent_stale_one"])
    # First POST = the /leave for the stale agent, second POST = the new /join.
    mock_client_instance.post.side_effect = [
        Response(status_code=200, json={}),
        Response(status_code=200, json={"agent_id": "agent_brand_new"}),
    ]
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=mock_client_instance):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as test_client:
            resp = await test_client.post(
                "/api/agora/start-agent",
                json={"channel_name": "force_restart_room", "agent_uid": 9999, "force_restart": True},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "started"
            assert data["agent_id"] == "agent_brand_new"

            # The stale agent's /leave must have been called before the new /join.
            called_urls = [c.args[0] for c in mock_client_instance.post.call_args_list]
            assert called_urls[0].endswith("/agents/agent_stale_one/leave")
            assert called_urls[1].endswith("/join")


@pytest.mark.asyncio
async def test_start_agent_proceeds_when_running_agent_lookup_fails(monkeypatch):
    """
    A failed duplicate-check must never block starting an agent -- a transient Agora
    API blip should degrade to the old behavior, not become an outage of our own.
    """
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_cert_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")
    monkeypatch.delenv("MCP_SERVER_PUBLIC_URL", raising=False)

    mock_client_instance = AsyncMock()
    mock_client_instance.get.return_value = Response(status_code=500, text="upstream boom")
    mock_client_instance.post.return_value = Response(
        status_code=200, json={"agent_id": "agent_started_anyway"}
    )
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=mock_client_instance):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as test_client:
            resp = await test_client.post(
                "/api/agora/start-agent",
                json={"channel_name": "lookup_fails_room", "agent_uid": 9999},
            )
            assert resp.status_code == 200
            assert resp.json()["agent_id"] == "agent_started_anyway"


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
            assert sent_payload["properties"]["parameters"] == {"data_channel": "rtm", "enable_error_message": True}


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
                    # Pinned to the BYOK-Gemini vendor deliberately: the
                    # live-only-model assertions below are about Gemini model
                    # selection, and composed_tools now defaults to managed
                    # OpenAI. MCP wiring on that default is covered by
                    # test_mcp_servers_wire_under_managed_openai_llm_too.
                    "composed_tools_llm_vendor": "gemini",
                    "mcp_server_url": "https://example.com/mcp",
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["voice_pipeline"] == "composed_tools"
            assert data["mcp_enabled"] is True
            assert data["mcp_server_url"] == "https://example.com/mcp"
            assert "WIRED PER OFFICIAL DOCS" in data["mcp_tool_calling_status"]
            assert "NOT YET LIVE-VERIFIED" in data["mcp_tool_calling_status"]

            sent_payload = mock_client_instance.post.call_args.kwargs["json"]
            props = sent_payload["properties"]
            assert "mllm" not in props

            assert "deepgram_nova_3" in sent_payload["preset"]
            assert "minimax_speech_2_8_turbo" in sent_payload["preset"]
            assert props["asr"]["language"] == "en-US"

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
                    "endpoint": "https://example.com/mcp",
                    "transport": "streamable_http",
                }
            ]

            assert props["tts"]["params"]["voice_setting"]["voice_id"] == "English_captivating_female1"

            assert props["advanced_features"]["enable_tools"] is True
            assert props["advanced_features"]["enable_rtm"] is True
            assert props["parameters"] == {"data_channel": "rtm", "enable_error_message": True}

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
            assert sent_payload["properties"]["parameters"] == {"data_channel": "rtm", "enable_error_message": True}


# ─── Agora-managed model wiring (composed_tools llm vendor) ──────────────────
#
# The hackathon organizers confirmed Agora Conversational AI is mandatory and
# pointed at Agora-managed models (Deepgram STT / OpenAI LLM / MiniMax TTS) as the
# path that needs no provider keys of your own. ASR and TTS were already managed;
# the LLM step was BYOK Gemini only, which meant the composed_tools pipeline could
# not run without a Gemini key and was subject to that key's quota. These lock in
# the managed-OpenAI option and the honesty of what gets reported back.


def _agora_env(monkeypatch):
    monkeypatch.setenv("AGORA_APP_ID", "mock_app_id_1234567890123456789012")
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", "mock_cert_1234567890123456789012")
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.delenv("MCP_SERVER_PUBLIC_URL", raising=False)


def _mock_agora_client():
    mock_client_instance = AsyncMock()
    mock_client_instance.post.return_value = Response(
        status_code=200, json={"agent_id": "agent_session_abc123", "status": "idle"}
    )
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.__aexit__.return_value = None
    return mock_client_instance


async def _start_agent(payload):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        return await test_client.post("/api/agora/start-agent", json=payload)


@pytest.mark.asyncio
async def test_composed_tools_defaults_to_agora_managed_openai(monkeypatch):
    """
    The default composed_tools LLM must be Agora-managed OpenAI: credential_mode
    'managed', vendor 'openai', and crucially NO api_key -- Agora's managed docs
    state the key is not required, and sending one would defeat the point.
    """
    _agora_env(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")
    client = _mock_agora_client()

    with patch("app.api.agora.httpx.AsyncClient", return_value=client):
        resp = await _start_agent(
            {
                "channel_name": "emergency_test_room",
                "agent_uid": 9999,
                "voice_pipeline": "composed_tools",
            }
        )

    assert resp.status_code == 200
    sent_payload = client.post.call_args.kwargs["json"]
    assert "openai_gpt_4o_mini" in sent_payload["preset"]
    assert "deepgram_nova_3" in sent_payload["preset"]
    assert "minimax_speech_2_8_turbo" in sent_payload["preset"]
    llm = sent_payload["properties"]["llm"]
    assert "api_key" not in llm, "managed mode must not send a key"
    assert "url" not in llm, "preset mode must not send url"
    # Shared fields still applied on top of the vendor-specific block.
    assert llm["system_messages"][0]["role"] == "system"
    assert llm["max_history"] == 32
    # Our own Gemini key must not leak into a managed-OpenAI request.
    assert "mock_gemini_api_key" not in str(sent_payload)

    data = resp.json()
    assert data["llm_provider"] == "openai"
    assert data["llm_credential_mode"] == "managed"


@pytest.mark.asyncio
async def test_composed_tools_managed_openai_needs_no_gemini_key(monkeypatch):
    """
    The whole value of the managed path is running with zero model keys of ours.
    Previously start-agent returned 503 whenever GEMINI_API_KEY was unset, which
    would have blocked exactly the configuration that does not need it.
    """
    _agora_env(monkeypatch)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    client = _mock_agora_client()

    with patch("app.api.agora.httpx.AsyncClient", return_value=client):
        resp = await _start_agent(
            {
                "channel_name": "emergency_test_room",
                "agent_uid": 9999,
                "voice_pipeline": "composed_tools",
            }
        )

    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_composed_tools_can_still_opt_back_into_byok_gemini(monkeypatch):
    """Gemini remains selectable; the managed default must not remove the option."""
    _agora_env(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")
    client = _mock_agora_client()

    with patch("app.api.agora.httpx.AsyncClient", return_value=client):
        resp = await _start_agent(
            {
                "channel_name": "emergency_test_room",
                "agent_uid": 9999,
                "voice_pipeline": "composed_tools",
                "composed_tools_llm_vendor": "gemini",
            }
        )

    assert resp.status_code == 200
    llm = client.post.call_args.kwargs["json"]["properties"]["llm"]
    assert llm["vendor"] == "custom"
    assert llm["style"] == "gemini"
    assert "generativelanguage.googleapis.com" in llm["url"]
    assert resp.json()["llm_credential_mode"] == "byok"
    # The key belongs in the upstream payload but never in our own response.
    assert "mock_gemini_api_key" not in str(resp.json())


@pytest.mark.asyncio
async def test_byok_gemini_still_requires_the_gemini_key(monkeypatch):
    """Relaxing the key check must not let a BYOK request through without a key."""
    _agora_env(monkeypatch)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    resp = await _start_agent(
        {
            "channel_name": "emergency_test_room",
            "agent_uid": 9999,
            "voice_pipeline": "composed_tools",
            "composed_tools_llm_vendor": "gemini",
        }
    )
    assert resp.status_code == 503
    assert "GEMINI_API_KEY" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_gemini_live_still_requires_the_gemini_key(monkeypatch):
    """gemini_live has no managed option at all -- it must keep failing loudly."""
    _agora_env(monkeypatch)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    resp = await _start_agent(
        {"channel_name": "emergency_test_room", "agent_uid": 9999}
    )
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_managed_asr_and_tts_stay_managed(monkeypatch):
    """
    Deepgram ASR and MiniMax TTS are the other two organizer-recommended managed
    models, and both need an explicit params.url even in managed mode (confirmed
    against live HTTP 400s from Agora's join API).
    """
    _agora_env(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")
    client = _mock_agora_client()

    with patch("app.api.agora.httpx.AsyncClient", return_value=client):
        resp = await _start_agent(
            {
                "channel_name": "emergency_test_room",
                "agent_uid": 9999,
                "voice_pipeline": "composed_tools",
            }
        )

    assert resp.status_code == 200
    sent_payload = client.post.call_args.kwargs["json"]
    assert "deepgram_nova_3" in sent_payload["preset"]
    assert "minimax_speech_2_8_turbo" in sent_payload["preset"]
    props = sent_payload["properties"]
    assert props["asr"]["language"] == "en-US"
    assert "params" in props["tts"]
    assert props["tts"]["params"]["voice_setting"]["voice_id"] == "English_captivating_female1"


@pytest.mark.asyncio
async def test_mcp_servers_wire_under_managed_openai_llm_too(monkeypatch):
    """
    MCP tool-calling hangs off the `llm` block, so it must survive the switch to
    Agora-managed OpenAI -- otherwise the keyless default would silently be the one
    configuration where tools stop being offered.
    """
    _agora_env(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")
    client = _mock_agora_client()

    with patch("app.api.agora.httpx.AsyncClient", return_value=client):
        resp = await _start_agent(
            {
                "channel_name": "managed_mcp_room",
                "agent_uid": 9999,
                "voice_pipeline": "composed_tools",
                "mcp_server_url": "https://example.com/mcp",
            }
        )

    assert resp.status_code == 200
    sent_payload = client.post.call_args.kwargs["json"]
    assert "openai_gpt_4o_mini" in sent_payload["preset"]
    props = sent_payload["properties"]
    assert props["llm"]["mcp_servers"] == [
        {
            "name": "tocsin-emergency-tools",
            "endpoint": "https://example.com/mcp",
            "transport": "streamable_http",
        }
    ]
    assert props["advanced_features"]["enable_tools"] is True


# ─── Live agent status / account-wide listing ────────────────────────────────
#
# A mentor pointed us at the real "query agent status" and "list agents"
# endpoints we had previously flagged in RESEARCH.md as CREDENTIAL REQUIRED /
# schema-unconfirmed. Tocsin could previously only report its own in-memory
# guess about whether an agent was still running, which goes stale the moment
# the backend restarts or Agora stops the agent server-side. These lock in the
# request/response shape confirmed against
# docs.agora.io/en/api-reference/api-ref/conversational-ai/query and .../list.


@pytest.mark.asyncio
async def test_agent_status_queries_agora_live_using_local_registry(monkeypatch):
    _agora_env(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")

    start_client = _mock_agora_client()
    with patch("app.api.agora.httpx.AsyncClient", return_value=start_client):
        start_resp = await _start_agent(
            {"channel_name": "status_check_room", "agent_uid": 9999}
        )
    agent_id = start_resp.json()["agent_id"]

    status_client = AsyncMock()
    status_client.get.return_value = Response(
        status_code=200,
        json={
            "message": "ok",
            "start_ts": 1735035893,
            "stop_ts": 0,
            "status": "RUNNING",
            "name": "tocsin_agent_status_check_room",
            "agent_id": agent_id,
        },
    )
    status_client.__aenter__.return_value = status_client
    status_client.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=status_client):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(f"/api/agora/agent-status/status_check_room")

    assert resp.status_code == 200
    data = resp.json()
    assert data["live_agora_state_verified"] is True
    assert data["status"] == "RUNNING"
    assert data["agent_id"] == agent_id
    # Queried the real per-agent endpoint, not the list endpoint.
    called_url = status_client.get.call_args.args[0]
    assert called_url.endswith(f"/agents/{agent_id}")


@pytest.mark.asyncio
async def test_agent_status_404s_when_nothing_known_locally(monkeypatch):
    """No local record and no ?agent_id= given -- must fail loudly, not guess."""
    _agora_env(monkeypatch)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/agora/agent-status/never_started_room")

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_agent_status_accepts_explicit_agent_id_override(monkeypatch):
    """Lets a caller check a specific agent_id after a backend restart wiped ACTIVE_AGENTS."""
    _agora_env(monkeypatch)

    status_client = AsyncMock()
    status_client.get.return_value = Response(
        status_code=200,
        json={
            "message": "ok",
            "start_ts": 1735035893,
            "stop_ts": 0,
            "status": "STOPPED",
            "name": "orphaned_agent",
            "agent_id": "orphan_123",
        },
    )
    status_client.__aenter__.return_value = status_client
    status_client.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=status_client):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(
                "/api/agora/agent-status/some_room", params={"agent_id": "orphan_123"}
            )

    assert resp.status_code == 200
    assert resp.json()["status"] == "STOPPED"


@pytest.mark.asyncio
async def test_agent_status_502s_when_agora_query_fails(monkeypatch):
    """A failed Agora lookup must surface as an error, never as a silent guess."""
    _agora_env(monkeypatch)

    status_client = AsyncMock()
    status_client.get.return_value = Response(status_code=500, text="internal error")
    status_client.__aenter__.return_value = status_client
    status_client.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=status_client):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(
                "/api/agora/agent-status/some_room", params={"agent_id": "whatever"}
            )

    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_list_agents_calls_the_account_wide_endpoint(monkeypatch):
    """
    The zombie-hunting use case: list every RUNNING agent on the account, not
    scoped to a channel we already know about.
    """
    _agora_env(monkeypatch)

    list_client = AsyncMock()
    list_client.get.return_value = Response(
        status_code=200,
        json={
            "data": {
                "count": 2,
                "list": [
                    {"agent_id": "a1", "status": "RUNNING", "start_ts": 111},
                    {"agent_id": "a2", "status": "RUNNING", "start_ts": 222},
                ],
            },
            "meta": {"cursor": "", "total": 2},
            "status": "ok",
        },
    )
    list_client.__aenter__.return_value = list_client
    list_client.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=list_client):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/agora/agents")

    assert resp.status_code == 200
    data = resp.json()
    assert data["data"]["count"] == 2
    called_url = list_client.get.call_args.args[0]
    assert called_url.endswith("/agents")
    assert "agents/" not in called_url.rsplit("/agents", 1)[0]


@pytest.mark.asyncio
async def test_list_agents_forwards_filters(monkeypatch):
    _agora_env(monkeypatch)

    list_client = AsyncMock()
    list_client.get.return_value = Response(
        status_code=200,
        json={"data": {"count": 0, "list": []}, "meta": {"cursor": "", "total": 0}, "status": "ok"},
    )
    list_client.__aenter__.return_value = list_client
    list_client.__aexit__.return_value = None

    with patch("app.api.agora.httpx.AsyncClient", return_value=list_client):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(
                "/api/agora/agents",
                params={"channel": "some_room", "state": 4, "limit": 5},
            )

    assert resp.status_code == 200
    forwarded_params = list_client.get.call_args.kwargs["params"]
    assert forwarded_params["channel"] == "some_room"
    assert forwarded_params["state"] == "4"
    assert forwarded_params["limit"] == "5"


@pytest.mark.asyncio
async def test_list_agents_blocked_when_credentials_missing(monkeypatch):
    monkeypatch.delenv("AGORA_APP_ID", raising=False)
    monkeypatch.delenv("AGORA_CUSTOMER_ID", raising=False)
    monkeypatch.delenv("AGORA_CUSTOMER_SECRET", raising=False)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/agora/agents")

    assert resp.status_code == 503


# ─── Agent's combined RTC+RTM token must be Token 007 ───────────────────────
# Regression test for the root cause confirmed live 2026-09-04 by an Agora
# engineer inspecting the agent process directly: the agent's `properties.token`
# was a Token 006 with a `kRtmLogin` privilege bolted onto it, which signs that
# privilege against the RTC (channel, uid) pair instead of a real RTM login
# grant. Agora's backend correctly rejected it -- the agent could still speak
# (RTC still validated) but could never log into RTM, so it never published a
# transcript. See app/vendor/agora_token007/__init__.py for the full account.
#
# Uses a real 32-character hex App ID/Certificate (unlike this file's other
# `mock_app_id_...` fixtures) because Token 007's own validation rejects
# non-hex identifiers outright (returns '' rather than raising) -- silently
# masking exactly the kind of mistake this test exists to catch.
_VALID_HEX_APP_ID = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
_VALID_HEX_APP_CERT = "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5"


@pytest.mark.asyncio
async def test_start_agent_token_is_token007_not_legacy_token006(monkeypatch):
    monkeypatch.setenv("AGORA_APP_ID", _VALID_HEX_APP_ID)
    monkeypatch.setenv("AGORA_APP_CERTIFICATE", _VALID_HEX_APP_CERT)
    monkeypatch.setenv("AGORA_CUSTOMER_ID", "mock_customer_id")
    monkeypatch.setenv("AGORA_CUSTOMER_SECRET", "mock_customer_secret")
    monkeypatch.setenv("GEMINI_API_KEY", "mock_gemini_api_key")
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
                json={"channel_name": "emergency_test_room", "agent_uid": 9999, "voice": "Puck"},
            )
    assert resp.status_code == 200

    sent_payload = mock_client_instance.post.call_args.kwargs["json"]
    token = sent_payload["properties"]["token"]
    assert token, "agent token must not be empty -- an empty token means build() silently rejected the app_id/cert"
    assert token.startswith("007"), (
        f"agent token must be Token 007 (prefix '007'), got prefix {token[:3]!r} -- "
        "this is the exact defect that made the agent unable to log into RTM"
    )

    # The real builder, not a hand-rolled equivalent: cross-check against a
    # directly-built token's decoded services rather than trusting the prefix
    # alone. Token 007 is non-deterministic (random salt), so compare structure,
    # not byte-for-byte equality.
    from app.vendor.agora_token007.AccessToken2 import AccessToken as AccessToken007

    parsed = AccessToken007(_VALID_HEX_APP_ID, _VALID_HEX_APP_CERT)
    assert parsed.from_string(token) is True, "Agora's own AccessToken007 parser must accept this token"
    service_types = {service.service_type() for service in parsed.services}
    # kServiceTypeRtc = 1, kServiceTypeRtm = 2 (AccessToken2.py) -- both scopes
    # must be present for the agent to have both RTC publish and RTM login.
    assert service_types == {1, 2}, f"expected both RTC and RTM services, got {service_types}"
