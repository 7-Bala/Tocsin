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

**Since verified live (2026-09-05)** — this paragraph originally recorded that no
real account had been exercised; that is no longer true and is kept here only so the
progression is traceable. A real PagerDuty account, service, escalation policy and
routing key were configured, and real incidents were triggered end-to-end: first by
a direct `call_tool()` through the running MCP server, then — the harder claim —
by the agent itself deciding to page during a `composed_tools` session. See the
status table below and `docs/pagerduty/AUTONOMOUS_PAGING_TEST_PLAN.md`.

Still mocked (deliberately, as unit tests rather than live calls):
`mock-services/tests/test_tools.py::test_tool_13_page_oncall_engineer_live_dispatch`
asserts the exact outbound request shape against a monkeypatched `httpx` client, so
the request contract stays pinned without paging a human on every test run.

## Status

| Capability | Status | Note |
|---|---|---|
| Events API v2 request/response shape (`routing_key`, `event_action`, `payload.{summary,source,severity}`, response `status`/`dedup_key`) | `OFFICIAL SOURCE (first-party GitHub example)` | Matches PagerDuty's own example code exactly. Not fetched from prose docs (see above). |
| `payload.severity` enum values | `CORROBORATED — TWO INDEPENDENT THIRD-PARTY SOURCES` | Not a direct quote from PagerDuty's own current docs; two independent sources agree, but this is a step below the project's usual "official docs" bar. |
| `page_oncall_engineer` MCP tool implementation | `VERIFIED IN CODE (mocked dispatch + live MCP protocol reachability)` | Real request shape asserted against a mocked httpx client; genuinely reachable and callable through the live, running MCP server. Not yet exercised against a real PagerDuty account. |
| Mock fallback when `PAGERDUTY_ROUTING_KEY` is unset | `VERIFIED IN CODE` | Live-called through the actual running MCP server; returned a clearly labeled `MOCK_FALLBACK` envelope, `paged: false`. |
| Live dispatch to a real PagerDuty account/on-call engineer | `VERIFIED LIVE (2026-09-05)` | Real `PAGERDUTY_ROUTING_KEY` configured against a real service ("Tocsin Incident Commander", auto-generated escalation policy with the account owner as default on-call). Called `page_oncall_engineer` through the live, running MCP server (not a direct Python call) with `severity="SEV2"`; got back `paged: true`, `delivery_status: "delivered"`. Confirmed independently in the PagerDuty UI: a real incident (#1, status "Triggered", correct title, correct service, "Assigned To" the account owner) appeared within seconds. Resolved afterward via a `event_action: "resolve"` call with the same `dedup_key` — confirmed the incident count returned to 0 triggered / 0 acknowledged. |
| Agent actually choosing to call this tool mid-conversation, unprompted | `VERIFIED LIVE (2026-09-05)` | Observed twice, in two independent `composed_tools` sessions. Escalating context was injected via `agent-think` **without ever naming the tool or asking for a page**. Low-severity context ("a few users said logins feel slow") → no tool call. Real partial-impact fault ("login API returning 503s for ~40% of requests, right after the deploy") → agent called `page_oncall_engineer` on its own, choosing **SEV2, not SEV1** — the correct call for partial rather than total impact, and notably declining to inflate severity "to be safe" as the prompt warns against. It also authored its own summary and `incident_id` (`identity-service-deployment`), neither of which was supplied. Real PagerDuty incident confirmed in their UI. Not yet observed via the spoken-voice/ASR path — only via `agent-think` injection. |
| Works under `gemini_live` (mllm) pipeline | `NOT SUPPORTED` | Same as every other MCP tool in this project — `mcp_servers` is documented only under `llm`, not `mllm`. Requires `composed_tools`. |

## To go live — DONE for steps 1-5 (2026-09-05)

1. ✅ Created a PagerDuty account (free trial).
2. ✅ Created a service ("Tocsin Incident Commander"), added the "Events API v2"
   integration, copied its Integration Key. Used PagerDuty's own "Generate a new
   Escalation Policy" default during service creation, which makes the account
   owner the default on-call — this is what answered "who gets paged" without
   Tocsin needing to track it.
3. ✅ `PAGERDUTY_ROUTING_KEY` set in `.env`, confirmed received by the running
   `mock-services` container (`docker compose exec mock-services` printenv check).
4. ✅ Escalation policy exists (the auto-generated default from step 2).
5. ✅ Rebuilt and live-tested: called `page_oncall_engineer` through the real
   running MCP server with `severity="SEV2"` — got `paged: true`,
   `delivery_status: "delivered"`. A real PagerDuty incident appeared within
   seconds (status "Triggered", correct title/service/assignee). Resolved it
   afterward with a matching `event_action: "resolve"` + same `dedup_key`;
   confirmed the incident count returned to 0/0.

6. ✅ **Agent autonomy verified (2026-09-05).** Under `composed_tools`, with
   escalating context injected via `agent-think` and the tool never named, the agent
   declined to page on a vague low-impact report and then paged on its own once given
   a real partial-impact fault — choosing SEV2 rather than inflating to SEV1, and
   writing its own summary and incident id. Reproduced across two sessions. Full
   transcript of what was injected and what it chose:
   `docs/pagerduty/AUTONOMOUS_PAGING_TEST_PLAN.md`.

**Remaining (not yet done):** the same behavior via the **spoken-voice path**
(microphone → ASR → LLM → tool call) rather than `agent-think` injection. The
injection path exercises the agent's judgment and the full MCP/PagerDuty chain, but
not Agora's ASR front-end. Needs a human at a microphone; Claude has none.
