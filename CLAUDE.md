# Tocsin — Claude Code Project Handoff

## Read this first

Tocsin is a hackathon prototype for the Agora/Knotic EchoSphere challenge:

> Build a real-time AI incident commander that joins a live operational or technical incident room, listens to discussion, organizes shared understanding, distinguishes facts from assumptions, tracks decisions and actions, detects missing or conflicting information, maintains a timeline, integrates with operational tools, provides spoken summaries, requires human confirmation for critical actions, and produces a final summary with unresolved risks.

The product is not an autonomous root-cause finder. Its central principle is:

> Organize evidence without inventing certainty.

## User priorities

- Optimize for a reliable, judge-verifiable prototype and a short mentor presentation.
- Treat the repository and exercised runtime behavior as the source of truth.
- Never invent features, credentials, external deliveries, live AI responses, or test results.
- Explicitly distinguish `VERIFIED LIVE`, `VERIFIED LOCALLY`, `IMPLEMENTED — CREDENTIAL REQUIRED`, `MOCK/DEMO ONLY`, `UNVERIFIED`, and `NOT IMPLEMENTED`.
- Preserve the user’s existing work. Do not reset, checkout, or discard changes.
- Before changing code, inspect the current diff and relevant files.
- Build one coherent slice, verify it, and report exact evidence.

## Competition context and positioning

Tocsin is being developed for the Agora/Knotic EchoSphere hackathon. The team
has reached Round 3, the online mentorship and development sprint. The
organizer's instruction for the mentor session was to explain the problem
statement and the prototype built so far; the team had approximately ten
minutes. The assigned mentor was Nitin, and Vaishnavi was hosting the round on
behalf of Knotic.

Another shortlisted team reportedly presented the same problem statement and a
similar payment-gateway-outage script. The competitor's team name, company,
implementation, and evidence are not known. Never invent the competitor's
identity or claim that it is a particular company. Treat this as an
unverified report from the user.

Tocsin should stand out through its evidence discipline and workflow depth:
it is a shared incident record built from a live conversation, with source
provenance, confirmed facts separated from hypotheses, contradiction and
missing-information detection, participant roles, owned actions and deadlines,
timeline events, human approval for critical operations, and an honest final
summary. This positioning must not become a claim that those capabilities are
all live or production-ready; verify each one in the repository and runtime.

Do not use a payment outage as the default presentation scenario. The current
scenario is a customer login and identity-service outage because it demonstrates
the same incident-coordination problem without copying the other team's story.

## Agora research requirement

Before making further claims about Agora architecture, APIs, or production
readiness, research the current official Agora documentation and inspect the
corresponding code. Record the results in `docs/agora/RESEARCH.md` so the
project has a durable, reviewable source of truth. Use official Agora sources
for technical claims; do not rely on memory, blog posts, or inferred behavior.

The research must cover, where applicable:

- Agora RTC Web SDK channel join, publishing, subscribing, permissions, and
  browser audio behavior.
- Agora Conversational AI / ConvoAI agent creation, join/leave lifecycle,
  model-provider wiring, Gemini Live configuration, callbacks, and errors.
- Agora stream messages, data streams, transcript/event delivery, and the
  exact path from a spoken utterance to Tocsin observation ingestion.
- Token generation, App ID/certificate handling, server-side issuance, and
  security boundaries.
- Audio recording, transcription, privacy, consent, and retention limitations.
- Agora Signaling/RTM only if it is currently supported and relevant; state
  clearly whether it is used or not used.
- MCP or external-tool integration only if officially documented for the
  selected Agora product; otherwise label it as Tocsin-side functionality.
- Current SDK/API versions, official examples, feature availability, and
  credential requirements.

For every researched capability, include: official source URL, date checked,
what the docs say, what Tocsin's code actually does, a minimal verification
step, and exactly one status: `VERIFIED IN CODE`, `OFFICIAL DOCS ONLY`,
`CREDENTIAL REQUIRED`, `UNVERIFIED`, or `NOT USED`. Do not upgrade a status
because an SDK is installed or an endpoint is configured. A successful
end-to-end runtime test is required for `VERIFIED IN CODE`.

When starting work in Claude Code, first read this file, then refresh or create
`docs/agora/RESEARCH.md` before changing Agora-related code. If the official
documentation is ambiguous or has changed, preserve the uncertainty and flag
it for the user instead of guessing.

## Current product architecture

### Backend

- Location: `backend/`
- FastAPI application entrypoint: `backend/app/main.py`
- Incident APIs: `backend/app/api/incidents.py`
- Observation ingestion: `backend/app/api/observations.py`
- Participants: `backend/app/api/participants.py`
- Summaries: `backend/app/api/summaries.py`
- Demo scenario: `backend/app/api/demo.py`
- Agora token and agent lifecycle: `backend/app/api/agora.py`
- Incident state/simulation: `backend/app/engine/simulator.py`
- Database abstraction: `backend/app/engine/database.py`
- Persistence repositories: `backend/app/engine/repositories.py`
- Gemini/fallback extraction: `backend/app/engine/extraction.py`
- Conflict detection: `backend/app/engine/conflict_detector.py`
- WebSocket broadcasting: `backend/app/engine/connection_manager.py`
- SQL migration: `backend/app/engine/migrations/001_initial_schema.sql`

The evidence model includes incidents, observations, claims, participants, decisions, action items, conflicts, missing information, unresolved risks, timeline entries, proposed actions, executed actions, and summaries.

### Frontend

- Location: `frontend/`
- Main incident dashboard: `frontend/src/app/page.tsx`
- Voice room page: `frontend/src/app/voice-test/page.tsx`
- Agora voice UI: `frontend/src/components/VoiceHUD.tsx`
- Intelligence suite: `frontend/src/components/IntelligencePanel.tsx`
- Demo controls: `frontend/src/components/DemoModeControl.tsx`
- WebSocket hook: `frontend/src/hooks/useIncidentWebSocket.ts`
- API hook: `frontend/src/hooks/useIncidentApi.ts`
- Incident types: `frontend/src/types/incident.ts`

The root dashboard `/` is the primary evidence/intelligence view. The `/voice-test` page is the voice-room interface and retains its original light visual design by user preference.

## Voice and Gemini architecture — important

There are two separate Gemini-related paths:

1. **Real-time voice agent:**

   Browser → Tocsin `/api/agora/start-agent` → Agora Conversational AI REST API → Agora ConvoAI joins Agora RTC → Agora ConvoAI uses Gemini Live through Gemini’s bidirectional WebSocket endpoint.

   The browser does not connect directly to Gemini for the voice agent. It connects to Agora RTC.

2. **Structured extraction:**

   Observation → Tocsin backend extraction layer → Gemini API when configured → structured claims → PostgreSQL → WebSocket/dashboard.

   If Gemini is missing or quota-limited, the extraction layer uses a heuristic fallback and must label output as `heuristic_fallback` / unverified where appropriate.

Relevant files: `backend/app/api/agora.py`, `frontend/src/components/VoiceHUD.tsx`, and `backend/app/engine/extraction.py`.

## Current scenario decision

Do not use a payment-gateway outage for the presentation; another team used the same scenario/script.

The preferred scenario is:

`Customer Login and Identity Outage`

Example observations:

1. Support: Customers are unable to log in across multiple regions.
2. Engineering: The login API is returning HTTP 503 errors for around 40% of requests.
3. Engineering: I suspect the authentication database is overloaded.
4. SRE: Database CPU and connection usage look normal and healthy.
5. Engineering: Login failures started shortly after the latest identity-service deployment.
6. Engineer: I will compare authentication error rates before and after the deployment within ten minutes.

This scenario demonstrates facts, a hypothesis, contradictory evidence, a possible contributing event, an action owner/deadline, and a safety decision before rollback.

## Demo and hardcoded-data boundary

The deterministic identity-outage route in `backend/app/api/demo.py` is a seeded demo/test scenario. It is useful for repeatable verification but must never be described as live AI output or live monitoring data.

For a truthful product walkthrough, prefer manually entering observations through the observation/transcript input path. Describe this as transcript observation ingestion, not as live Gemini/Agora behavior unless those services are visibly active.

Use `/` for the backend-backed intelligence dashboard. Use `/voice-test` only when demonstrating the voice-room interface.

## Honest capability status

Currently verified in the local workspace:

- Backend suite: 39 tests passed in the last verified run.
- Frontend suite: 16 tests passed in the last verified run.
- Frontend production build: passed.
- PostgreSQL live tests: passed locally against Docker PostgreSQL.
- Observation ingestion, persistence, conflict/action/timeline behavior: locally tested.

Credential/environment-dependent:

- Gemini successful live extraction requires an available API key and quota. A successful configured request must return `extraction_method: "llm"` before claiming live Gemini verification.
- Agora RTC and Agora ConvoAI require active Agora credentials, a running room, and microphone/browser permission.
- Spoken audio summary broadcast requires an active Agora session.
- Real Slack delivery requires a real Slack webhook. A localhost HTTP server is only a webhook contract test.
- PagerDuty, Jira, and cloud operational actions are currently mock/demo workflows unless separately exercised against real services.

Do not call the project production-ready. Use:

> A reliable, evidence-bounded prototype with a production-oriented architecture.

## Safety requirements

- No default or hardcoded commander secret.
- `/resolve` and critical action paths must be authenticated.
- Rejected actions are terminal.
- Duplicate approvals must fail safely.
- Critical actions require explicit human commander approval.
- Integration failure must be visible and must not be reported as success.
- AI-generated summaries must state that Tocsin organized reported evidence and did not independently determine root cause.

## UI requirements

- Keep `/voice-test` on its original light design unless the user explicitly asks to change it.
- Keep `/` as the modern styled intelligence dashboard.
- Never show stale flood or payment labels in the identity scenario.
- Make evidence status and source visible.
- Avoid fake telemetry, unexplained confidence percentages, and empty decorative panels.
- Use restrained motion: short custom ease-out transitions, press feedback, and reduced-motion support.
- Prioritize clarity over visual effects.

## Verification commands

From the repository root:

```bash
cd backend
../.venv/bin/python -m pytest tests -q

cd ../frontend
npm test
npm run build

cd ..
git diff --check
```

If Docker is running and the frontend image needs refreshing:

```bash
docker compose up -d --build frontend
```

Never report a test as live, passed, or unskipped without the actual command output.

## Current uncommitted work

The working tree contains user/agent changes related to:

- Identity-outage scenario migration.
- Root dashboard styling and Tailwind setup.
- Voice-test labels/defaults.
- Intelligence panels and tests.
- Backend persistence, extraction, conflict, summary, security, and demo functionality.

Inspect `git status --short` and `git diff` before editing. Do not remove or overwrite these changes without explicit instruction.

## Recommended next work

If asked to continue development:

1. Exercise the identity scenario end-to-end through the actual UI.
2. Verify the browser rendering at `/` and `/voice-test`, not only static tests.
3. Remove generated local database files from version control.
4. Keep README capability labels evidence-bounded.
5. Add an organization-level active-incidents overview after the single-incident workflow is reliable.

## Communication style

Explain technical work in plain language first, then provide file/test details. Be direct about what is real, mocked, credential-dependent, broken, or unverified. When handing work back, list changed files, verification commands, failures/warnings, and remaining limitations.
