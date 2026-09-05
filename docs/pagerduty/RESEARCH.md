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
| Agent choosing to page from SPOKEN VOICE, unprompted | `VERIFIED LIVE (2026-09-05)` | Full mic -> Agora ASR -> LLM -> MCP -> PagerDuty chain. Scenario B spoken aloud, tool never named: agent paged at SEV1 with its own incident_id and summary, PagerDuty returned 202. Scenario A produced SEV2 from the same prompt, so severity tracks the facts. |
| Agent actually choosing to call this tool mid-conversation, unprompted | `VERIFIED LIVE (2026-09-05)` | Observed twice, in two independent `composed_tools` sessions. Escalating context was injected via `agent-think` **without ever naming the tool or asking for a page**. Low-severity context ("a few users said logins feel slow") → no tool call. Real partial-impact fault ("login API returning 503s for ~40% of requests, right after the deploy") → agent called `page_oncall_engineer` on its own, choosing **SEV2, not SEV1** — the correct call for partial rather than total impact, and notably declining to inflate severity "to be safe" as the prompt warns against. It also authored its own summary and `incident_id` (`identity-service-deployment`), neither of which was supplied. Real PagerDuty incident confirmed in their UI. Superseded by the row above, which proves the same behaviour through the spoken-voice path. |
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

7. ✅ **Spoken-voice path VERIFIED LIVE (2026-09-05).** Previously the one
   remaining gap: every earlier proof went through `agent-think` injection, which
   exercises the agent's judgment and the full MCP/PagerDuty chain but not
   Agora's ASR front-end.

   A human ran the Scenario B script (orders-service crash-loop) aloud into a
   microphone. Nothing in the script names the tool, mentions paging, or asks for
   an escalation. The agent paged on its own, from speech alone:

   ```
   11:27:11 [INFO] tocsin.mcp_tools - page_oncall_engineer invoked:
            incident_id='order_service_500_error' severity=SEV1
            (-> PagerDuty 'critical')
            summary='All customers are unable to place orders;
                     API returns a 500 error consistently.'
   11:27:12 [INFO] httpx - HTTP Request:
            POST https://events.pagerduty.com/v2/enqueue "HTTP/1.1 202 Accepted"
   ```

   Four things worth recording, because they are what distinguishes judgment from
   obedience:
   - **SEV1, and Scenario A produced SEV2.** Two runs, two severities, decided
     only by the facts given. This is the evidence that the severity ladder is
     real rather than a fixed response.
   - **It paged one beat EARLY.** The page fired at 11:27:11, after only
     "customers can't place orders at all, it's everything" — before the
     crash-loop detail at 11:27:41. Total impact was already established; it did
     not need the extra evidence the script planned to give it.
   - **`incident_id` and `summary` are its own.** Neither was supplied.
   - **Exactly one page** across 6m51s and 115 observations. No duplicates.

   Its spoken reasoning was also correct throughout: it caught the traffic-spike
   contradiction, kept the deployment link a correlation rather than a cause,
   refused to roll back without approval, and stated in the final summary that it
   had not determined root cause.

**Caveat, stated plainly:** the paging path is verified; the *evidence record*
that same run produced was badly broken (fragment flood, mic echo recorded as
operator speech, heuristic garbage — see `TODO.md`). Those are fixed separately
and are unrelated to the tool call above, but a demo of this capability should
not be read as a demo of the record's quality in that same session.

## "How does Tocsin know who is on call this week?"

**It doesn't — deliberately.** Tocsin stores no on-call roster, no schedule, and no
phone numbers or contact details for anyone.

PagerDuty's **escalation policy** owns that entirely. Tocsin fires one event at a
routing key; PagerDuty then resolves "who is on call right now" against its own
schedule and contacts them however that policy specifies (push, SMS, phone call),
including retry and escalation to a secondary if the first responder doesn't ack.

Why this is the right split, not a shortcut:
- **No stale roster.** An on-call rota changes weekly. A copy inside Tocsin would
  silently page last week's engineer the moment it drifted.
- **No PII.** Tocsin never holds a real person's phone number or email, which
  matters for a hackathon prototype handled by people other than its author.
- **Escalation is a solved, hard problem.** Retry timing, ack windows, secondary
  escalation, timezone-aware handoffs, holiday overrides — PagerDuty does all of
  this. Reimplementing it badly would be strictly worse.

The only thing Tocsin decides is **whether this is worth paging a human about, and
at what severity** — which is the actual judgment call, and the part that is
verified working (see the status table above).

### Possible extensions, if wanted later

Ranked by value-to-effort, none implemented:

1. **Read back who was paged.** After a successful trigger, PagerDuty's REST API
   (`GET /incidents/{id}`, needs a separate API token — not the routing key) can
   report which responder it actually reached. The agent could then say "I've
   paged Dave, he's on call" out loud instead of "I've paged the on-call
   engineer." Highest demo value for the least work.
2. **Acknowledge/resolve from the room.** `event_action` also accepts
   `acknowledge` and `resolve`. A commander saying "I've got this" could ack the
   page without leaving the call.
3. **Link the PagerDuty incident back into the Tocsin record.** Store the returned
   `dedup_key` on the Tocsin incident so the two systems cross-reference, and the
   final report can state exactly who was paged and when.
4. **Escalate on silence.** If a page goes unacknowledged for N minutes and the
   conversation is still active, the agent could say so in the room — turning
   PagerDuty's escalation into something the humans in the call actually hear.
