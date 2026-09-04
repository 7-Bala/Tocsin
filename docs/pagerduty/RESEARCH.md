# PagerDuty on-call paging — research and status

Same evidence-discipline convention as `docs/agora/RESEARCH.md`: official source,
what the docs say, what Tocsin's code actually does, a minimal verification step,
and exactly one status per capability. No claim of production readiness.

## Background

From a 2026-09-05 mentor call (Nitin, Agora): the requested capability is that when
the agent detects something critical during a live incident conversation, it should
categorize severity (SEV1/SEV2/SEV3) and page the on-call developer, informing them
about the incident — with no human commander approval required first (unlike
Tocsin's existing high-impact-action approval gate for things like rollbacks).

## Design decision: no on-call roster of our own

Tocsin does not track who is on-call, their phone number, or an escalation schedule.
PagerDuty's own escalation policy (configured on the PagerDuty side, entirely outside
this codebase) already owns that responsibility — it is what actually decides who
gets contacted and how (phone call, SMS, push notification, per whatever that policy
specifies). Tocsin's only job is to trigger a real PagerDuty alert against a routing
key; who receives it and how is PagerDuty's problem, not something invented here.

This also means Tocsin never stores a real person's contact information, which
matters for a hackathon prototype handled by people other than its author.

## What was verified, and how

**Source**: `github.com/PagerDuty/API_Python_Examples`,
`EVENTS_API_v2/trigger/trigger_without_incident_key.py` — PagerDuty's own official
example code (first-party, not a blog post or inferred behavior), checked 2026-09-05.

Confirmed directly from that file:
- Endpoint: `POST https://events.pagerduty.com/v2/enqueue`
- Body: `{"routing_key": ..., "event_action": "trigger", "payload": {"summary": ..., "source": ..., "severity": ...}}`
- A successful response has `"status": "success"` and a `"dedup_key"`; the example
  checks `status == "success"` before treating the trigger as accepted, and prints
  the response body verbatim on any other status.

**`payload.severity` enum** (`critical` / `error` / `warning` / `info`, lowercase):
not found documented on the one developer.pagerduty.com page this session
attempted to fetch (returned empty/truncated content both times it was tried,
likely a JS-rendered page WebFetch could not execute) — so this is **not**
sourced from PagerDuty's own prose docs directly. Instead corroborated by two
independent third-party sources that both name the same four values:
`argo-rollouts.readthedocs.io`'s PagerDuty v2 notification-service integration
docs, and a PagerDuty community forum thread
(`community.pagerduty.com/ask-a-product-question-2/status-code-400-in-events-api-v2-250`)
describing a 400 error caused by an invalid severity value. Two independent
sources agreeing is stronger than one, but this is still corroborated
third-party evidence, not a direct quote from PagerDuty's own current docs —
flagged here rather than silently upgraded to "confirmed by official docs."

**Not verified**: an actual live PagerDuty account and routing key have not been
exercised end-to-end. Live-verified so far is `page_oncall_engineer`'s own dispatch
logic against a *mocked* `httpx` client asserting the exact request shape (see
`mock-services/tests/test_tools.py::test_tool_13_page_oncall_engineer_live_dispatch`)
and the tool's real reachability through the actual running FastMCP server over
Streamable HTTP (`list_tools()` shows it; `call_tool()` executes it) — but with no
`PAGERDUTY_ROUTING_KEY` configured yet, so only the mock-fallback path has been
exercised against the live server, not the real PagerDuty API.

## Status

| Capability | Status | Note |
|---|---|---|
| Events API v2 request/response shape (`routing_key`, `event_action`, `payload.{summary,source,severity}`, response `status`/`dedup_key`) | `OFFICIAL SOURCE (first-party GitHub example)` | Matches PagerDuty's own example code exactly. Not fetched from prose docs (see above). |
| `payload.severity` enum values | `CORROBORATED — TWO INDEPENDENT THIRD-PARTY SOURCES` | Not a direct quote from PagerDuty's own current docs; two independent sources agree, but this is a step below the project's usual "official docs" bar. |
| `page_oncall_engineer` MCP tool implementation | `VERIFIED IN CODE (mocked dispatch + live MCP protocol reachability)` | Real request shape asserted against a mocked httpx client; genuinely reachable and callable through the live, running MCP server. Not yet exercised against a real PagerDuty account. |
| Mock fallback when `PAGERDUTY_ROUTING_KEY` is unset | `VERIFIED IN CODE` | Live-called through the actual running MCP server; returned a clearly labeled `MOCK_FALLBACK` envelope, `paged: false`. |
| Live dispatch to a real PagerDuty account/on-call engineer | `CREDENTIAL REQUIRED — NOT YET LIVE-VERIFIED` | Needs a real `PAGERDUTY_ROUTING_KEY` (an Events API v2 service integration key, not an account API token) and, ideally, an actual on-call schedule to confirm a real page arrives. |
| Agent actually choosing to call this tool mid-conversation, unprompted | `NOT YET LIVE-VERIFIED` | Same open question as every other MCP tool under `composed_tools` per `docs/agora/RESEARCH.md` — tool wiring matches Agora's documented schema, but whether the LLM autonomously decides to invoke it in a real conversation has not been observed yet for this specific tool. |
| Works under `gemini_live` (mllm) pipeline | `NOT SUPPORTED` | Same as every other MCP tool in this project — `mcp_servers` is documented only under `llm`, not `mllm`. Requires `composed_tools`. |

## To go live

1. Create a PagerDuty account (free trial is sufficient for a demo).
2. Create a service, add an "Events API v2" integration to it, copy its
   Integration Key.
3. Set `PAGERDUTY_ROUTING_KEY` in `.env` (see `.env.example`) — the mock-services
   container reads it via `docker-compose.yml`.
4. Configure at least one on-call schedule/escalation policy on that service, or
   the alert will trigger correctly but nothing will page anyone.
5. Rebuild: `docker compose up -d --build mock-services`.
6. Ask the agent (under `composed_tools`, not `gemini_live`) something that should
   trigger a page, and confirm a real PagerDuty incident appears in their console
   with `dedup_key` matching the Tocsin incident id.
