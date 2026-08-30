"""
Slack & External Messaging Integration Tests
Verifies:
1. Live HTTP response handling for Slack webhook (200 OK -> delivered, LIVE_EXTERNAL).
2. Error response handling (500/400 -> not delivered).
3. Timeout handling.
4. Missing credentials produce MOCK_FALLBACK (skipped_no_credentials).
5. The system never reports delivered when no message was sent.
"""

import os
import sys
import pytest
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

# Import notify_stakeholders from mock-services server
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../../mock-services")))
from server import notify_stakeholders


class MockSlackServerHandler(BaseHTTPRequestHandler):
    response_code = 200

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        MockSlackServerHandler.last_body = body
        self.send_response(MockSlackServerHandler.response_code)
        self.end_headers()
        self.wfile.write(b"ok" if MockSlackServerHandler.response_code == 200 else b"error")

    def log_message(self, format, *args):
        pass  # Quiet logs during test


@pytest.fixture(scope="module")
def mock_slack_server():
    server = HTTPServer(("127.0.0.1", 0), MockSlackServerHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}/webhook"
    server.shutdown()


@pytest.mark.asyncio
async def test_slack_successful_delivery(mock_slack_server, monkeypatch):
    """When SLACK_WEBHOOK_URL is configured and returns 200, report delivered."""
    MockSlackServerHandler.response_code = 200
    monkeypatch.setenv("SLACK_WEBHOOK_URL", mock_slack_server)

    res = await notify_stakeholders("inc-slack-01", "Evacuate Sector 7 immediately.")
    assert res["tool_classification"] == "LIVE_EXTERNAL"
    assert res["delivery_status"] == "delivered"
    assert res["sent"] is True
    assert res["channel"] == "slack"


@pytest.mark.asyncio
async def test_slack_server_error_response(mock_slack_server, monkeypatch):
    """When webhook returns HTTP 500, delivery fails and is not claimed as delivered."""
    MockSlackServerHandler.response_code = 500
    monkeypatch.setenv("SLACK_WEBHOOK_URL", mock_slack_server)

    res = await notify_stakeholders("inc-slack-02", "Flood surge alert")
    # Delivery failed, should not claim sent=True
    assert res.get("sent") is False or res.get("delivery_status") != "delivered"


@pytest.mark.asyncio
async def test_slack_timeout_handling(monkeypatch):
    """When endpoint is unreachable or times out, fail gracefully."""
    # Non-routable IP to induce timeout/refusal
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "http://127.0.0.1:59999/nonexistent")

    res = await notify_stakeholders("inc-slack-03", "Test timeout message")
    assert res.get("sent") is False


@pytest.mark.asyncio
async def test_no_credentials_transparent_mock_fallback(monkeypatch):
    """When neither SLACK_WEBHOOK_URL nor TELEGRAM_BOT_TOKEN is set, return MOCK_FALLBACK."""
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)

    res = await notify_stakeholders("inc-slack-04", "Simulated alert")
    assert res["tool_classification"] == "MOCK_FALLBACK"
    assert res["delivery_status"] == "skipped_no_credentials"
    assert res["sent"] is False
    assert "NOT ACTUALLY SENT" in res["status_for_agent"]
