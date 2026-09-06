# Tocsin — Architecture & Technical Overview

This is the single technical reference for how Tocsin is actually built and how it
actually behaves — grounded in the code as it exists today, not the plan for it.
Where something is unverified, mock, or credential-gated, it's labeled that way
explicitly rather than implied to be live. See the root [`README.md`](../README.md)
for setup/run instructions and [`CLAUDE.md`](../CLAUDE.md) for project conventions.

---

## 1. What it is, in one paragraph

Tocsin is a voice AI that joins a live incident call as an actual participant — not
a bot bolted onto a transcript afterward. It listens over real-time voice, keeps a
running evidence record that separates confirmed facts from hunches, flags
contradictions the moment two people disagree, and can page a real on-call engineer
autonomously — but only by its own judgment of severity, never on a keyword, and
never anything more destructive than that without an explicit human approval.

---

## 2. System architecture

```
                    ┌─────────────────────────────────────────┐
                    │              Agora RTC room               │
                    │   (all humans + the Tocsin agent, live)   │
                    └───────────────┬─────────────┬────────────┘
                                    │             │
                          voice in/out       transcript (RTM)
                                    │             │
                    ┌───────────────▼───┐   ┌─────▼──────────────┐
                    │  Agora Conversat-  │   │  Frontend (Next.js) │
                    │  ional AI agent    │   │  reads growing text  │
                    │  (2 pipeline modes,│   │  via TurnSettler     │
                    │   see §3)          │   │  (2s silence debounce)│
                    └────────┬───────────┘   └─────────┬───────────┘
                             │                          │
                    tool calls (MCP)           POST new observation
                             │                          │
                    ┌────────▼───────────┐    ┌─────────▼───────────┐
                    │  mock-services      │    │  FastAPI backend     │
                    │  (FastMCP, 14 tools)│    │  extraction pipeline  │
                    │  → PagerDuty        │    │  (§5) classifies it   │
                    │  → Slack/Telegram   │    │  into the evidence    │
                    └────────────────────┘    │  ontology (§6)        │
                                                └─────────┬───────────┘
                                                          │
                                              persist + broadcast full
                                              state snapshot over WS
                                                          │
                                                ┌─────────▼───────────┐
                                                │  PostgreSQL           │
                                                │  (incidents,          │
                                                │   observations,       │
                                                │   claims, conflicts,  │
                                                │   action_items, ...)  │
                                                └───────────────────────┘
```

Two independent pipelines read the same live conversation for two different jobs:
the **agent's own reasoning loop** (deciding what to say and when to call a tool)
and the **evidence-extraction pipeline** (deciding how to classify and display what
was said). Neither feeds back into the other — the extraction pipeline never
changes what the agent says, and the agent's tool calls never depend on the
whiteboard's current state, only on its own conversation context.

---

## 3. Voice pipeline — two modes

Selected per session via `voice_pipeline` (`backend/app/api/agora.py`):

### `gemini_live` ("Gemini Live")
One integrated model handles speech-in → reasoning → speech-out end-to-end over a
single bidirectional WebSocket to Google's Gemini Live API. Lowest latency, most
natural turn-taking. **Cannot call tools** — Agora's own documentation states
`mcp_servers` is only a valid field under `llm`, never under `mllm`, and enabling
`mllm` disables ASR/LLM/TTS as separate steps entirely. Confirmed two ways in
[`docs/agora/RESEARCH.md`](agora/RESEARCH.md): the official docs, and directly
asking an EchoSphere mentor.

### `composed_tools` ("Managed Tools") — the default
Three separate managed services chained together instead of one integrated model:

| Step | Vendor | Model |
|---|---|---|
| Speech-to-text | Deepgram (Agora-managed) | `nova-3` |
| Reasoning | OpenAI (Agora-managed, default) or your own Gemini key | `gpt-4o-mini` / `gemini-3.6-flash` |
| Text-to-speech | MiniMax (Agora-managed) | `speech-2.8-turbo` |

Higher latency (three hops instead of one integrated model — measured ~2.5s
end-to-end per turn: ~640ms ASR, ~830ms LLM, ~420ms TTS, ~260ms transport) but this
is the only mode where `llm.mcp_servers` is documented and wired, which is what
gives the agent real tool access (paging, incident-status lookups, etc.). Set as
the app's default since every judged capability requires it — Gemini Live silently
has no hands at all, with no error surfaced.

**Note on `gemini-3.1-flash-live-preview`** (the `gemini_live` pipeline's own
model): it's a WebSocket-Live-only model and cannot be reused for the
`composed_tools` reasoning step — confirmed live, it returns HTTP 400 if called
through `composed_tools`' plain REST endpoint, which is why that path uses the
separate `gemini-3.6-flash` model instead when BYOK Gemini is selected.

---

## 4. The agent's tool-calling loop

1. Agora transcribes your speech (Deepgram, in `composed_tools`).
2. The text goes to the LLM along with a system prompt: the incident-commander
   instructions, the roster of up to 14 available tools
   (`MCP_TOOL_ROSTER_NOTICE` in `agora.py`), and — critically — the session's
   real `incident_id` (== the Agora `channel_name`), explicitly grounded so the
   model can't invent a placeholder one. (This was a real, live-observed bug:
   without that grounding, the model invented ids like `"login_api_issue"` on
   every tool call, breaking PagerDuty's alert deduplication.)
3. The LLM either replies in words, or calls a tool if it judges that's warranted.
4. A tool call routes to `mock-services` (a standalone FastMCP HTTP server, 14
   tools: incident-status lookup, proposing/dispatching resolution actions,
   stakeholder notification, and `page_oncall_engineer`), which executes real
   logic — e.g. an actual HTTP call to PagerDuty's Events API v2 — and returns a
   structured result to the LLM.
5. The LLM folds that result into its next reply ("I've paged the on-call
   engineer at SEV2") and MiniMax speaks it back into the room.

**Tocsin never sends email itself** — there is no email-sending code anywhere in
this project. `page_oncall_engineer` POSTs to PagerDuty's real Events API
(`events.pagerduty.com/v2/enqueue`); PagerDuty responds `202 Accepted` confirming
the trigger was received, and from there it's entirely PagerDuty's own escalation
policy and the on-call person's own notification settings (email/SMS/push/phone)
that decide what actually reaches them — outside this codebase's visibility.

---

## 5. Structured extraction (evidence classification)

Separate from the agent's own reasoning above. Every settled utterance is run
through `backend/app/engine/extraction.py`:

1. **Primary**: Gemini API, model `gemini-3.7-flash` (direct key, JSON-schema
   enforced structured output).
2. **Fallback**: Groq API, model `openai/gpt-oss-120b`, tried only when Gemini is
   unavailable or its quota is exhausted (Gemini's free tier: 20 req/day; Groq's:
   ~1000 req/day).
3. **Last resort**: a plain rule-based heuristic (no model at all) if both LLMs
   are down. Every output from this path is explicitly tagged
   `extraction_method: "heuristic_fallback"` — never silently presented as an
   LLM's judgment.

---

## 6. The evidence ontology

Every classified utterance becomes one of:

| Category | Meaning | Never conflated with |
|---|---|---|
| `REPORT` | A confirmed fact, reported by someone on the call | A hypothesis |
| `HYPOTHESIS` | An unconfirmed suspicion ("I suspect X") | A confirmed fact |
| `DECISION` | An explicit choice made on the call | A proposal |
| `ACTION_ITEM` | A commitment with an owner and (often) a deadline | A vague mention |
| `RISK` | A named unresolved risk | A resolved one |

**Contradiction detection**: when two claims about the same entity conflict (e.g.
"the database is overloaded" vs. "the database is healthy"), a `ConflictRecord` is
created, surfaced as **Needs Human Resolution** — the system never silently picks a
side. A human must explicitly mark it resolved.

**Correlation vs. causation**: the system prompt explicitly requires hedged
language ("may be related," "worth investigating") for timing correlations, and
forbids asserting causation from a mere sequence of events.

---

## 7. Safety & the human-approval model

Two different action classes, deliberately gated differently:

- **`page_oncall_engineer`** — no pre-approval required. Paging a human is
  reversible (worst case: someone is woken up for nothing), so the agent can call
  it directly the moment it forms a grounded, evidence-backed judgment. It's
  explicitly told *not* to default to the highest severity "to be safe," since an
  inflated severity is its own kind of harm.
- **`propose_incident_action` / `dispatch_resolution_action`** — anything
  potentially destructive (e.g. a rollback) is queued as `PENDING_APPROVAL` and
  requires an explicit human (the Incident Commander, gated by
  `TOCSIN_COMMANDER_KEY`) to approve before it executes. The agent must state its
  evidence and hand the decision back — never claim to have already acted.

---

## 8. Real-time update mechanism

- **Transport**: one WebSocket per incident (`backend/app/engine/connection_manager.py`).
- **Message shape**: `{"type": "INCIDENT_SNAPSHOT", "state": {...}}` — the
  **entire current incident state**, not an incremental diff. Every change
  (a new observation, a resolved conflict, an approved action) triggers a fresh
  full-state broadcast. This trades a larger payload per update for the guarantee
  that the frontend can never drift out of sync from a missed or misordered patch.
- **Frontend**: `useIncidentWebSocket.ts` receives the snapshot and replaces its
  local state wholesale; every panel re-renders from that.

---

## 9. How the UI actually displays it

Two distinct rendering paths for two different jobs:

- **Side panels** (Live Situation, Possible Causes, Contradictions, Action Items,
  Decisions) are direct reads off the incident state — each `.map()`s over its own
  array (`claims`, `conflicts`, `action_items`, `hypotheses`, ...) with styling
  driven by a status field on each entry. No transformation, just direct render.
- **The whiteboard flowchart** is computed, not read directly. A pure function,
  `deriveIncidentGraph()` (`frontend/src/lib/deriveIncidentGraph.ts`), turns the
  same state into an actual graph — nodes, edges, node health/color, layout rank —
  independently unit-tested (`incident_graph_decisions.test.ts`) with no
  dependency on React or the live socket. That graph is handed to
  `ExcalidrawIncidentMap`, which draws it using **Excalidraw** (the open-source
  library behind excalidraw.com) as the canvas.

---

## 10. Persistence & privacy

- **PostgreSQL** holds the durable record: incidents, observations, claims,
  conflicts, action items, risks, timeline entries, summaries.
- **The incident record is deliberately ephemeral**: leaving the voice channel
  purges the incident and everything under it. It's built to be the shared
  memory of one live call, not a database you browse afterward — unless you
  explicitly generate a final report/handoff brief before leaving.
- **Redis** is provisioned in `docker-compose.yml` / `.env` but is not currently
  wired to any feature in this codebase — reserved capacity, not a live path.
  Stated here plainly rather than left to imply otherwise.

---

## 11. Repository map

```
backend/
  app/api/            REST endpoints (incidents, observations, agora, demo)
  app/engine/         extraction.py, conflict_detector.py, simulator.py,
                      repositories.py, connection_manager.py, database.py
  app/models/         evidence-model types (Observation, Claim, ConflictRecord, ...)
mock-services/
  server.py           the 14-tool MCP server (FastMCP) the agent calls into
frontend/
  src/app/voice-test/ the single page — both the voice room AND the dashboard
  src/lib/            deriveIncidentGraph.ts, agoraRtmTranscripts.ts, turnSettler.ts
  src/components/     ExcalidrawIncidentMap.tsx and the rest of the panel UI
docs/
  agora/RESEARCH.md       Agora API research, verified vs. unverified
  pagerduty/RESEARCH.md   PagerDuty Events API v2 research
  strategy/               positioning and roadmap docs
```

---

## 12. Honest capability status

Per this project's own evidence-bounded convention — a status is never upgraded
because a key is present or an endpoint is configured, only because it's been
exercised and observed:

| Capability | Status |
|---|---|
| Voice pipeline (both modes), tool-calling under `composed_tools` | `VERIFIED LIVE` |
| Structured extraction (Gemini → Groq → heuristic) | `VERIFIED LIVE` |
| Contradiction detection, action items, correlation restraint | `VERIFIED LIVE` (acceptance-tested) |
| Real PagerDuty paging (with routing key configured) | `VERIFIED LIVE` — confirmed via `202 Accepted` from PagerDuty's own API |
| Slack/Telegram stakeholder broadcast | `IMPLEMENTED — CREDENTIAL REQUIRED`; explicit labeled mock fallback when unset |
| Redis | provisioned, `NOT USED` by any current feature |
| Production readiness | **Not claimed.** This is a reliable, evidence-bounded prototype with a production-oriented architecture, not a hardened production system. |

### Known, stated limitations
- Crosstalk between two humans speaking at once has not been specifically
  stress-tested; turn attribution relies on each speaker's own audio stream.
- The ~2 second silence debounce before a sentence becomes a permanent record is
  intentional (it's what prevents one sentence fragmenting into several records),
  not a lag to be optimized away.
