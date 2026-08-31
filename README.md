# Tocsin — Real-Time Voice AI Incident Commander

Tocsin is a real-time AI Incident Commander platform designed for live incident command rooms. It joins incident discussions via voice audio or transcript ingestion, maintains a shared evidence record, separates confirmed facts from unverified assumptions, tracks key decisions, detects contradictory claims, manages action items with ownership and overdue follow-up, enforces strict human approval before emergency operational actions can execute, and generates evidence-bounded incident summaries with explicit AI disclaimers.

---

## Current status

The root `/` dashboard (evidence record, conflict resolution, provenance, handoff
briefs, human approval workflow) is verified locally and, per the capability matrix
below, mostly `VERIFIED LOCALLY` or `VERIFIED LIVE`. It is the primary way to see
Tocsin actually work.

`/voice-test` (the standalone voice-room chat interface) had real, diagnosed gaps found
via live browser testing on 2026-08-31. **As of the same day, typed messages now
produce a real Tocsin reply directly under the prompt** — logged category, evidence
status, extracted claim, and extraction method, with a 12s server-side timeout + 20s
client-side timeout so the chat can never hang silently (a live-observed defect: one
extraction call took 173 seconds with no error before this fix). What's still open:
the right-hand "Incident Command" tiles are driven by a client-side regex simulator
disconnected from the real backend evidence engine — see `TODO.md` item 1. Full detail,
root cause, and fix plan for every open item live in **[`TODO.md`](TODO.md)** — that
file is the single source of truth for pending work and is kept up to date after every
work session, so check it rather than assuming this README's capability matrix implies
everything is wired end-to-end.

Additional research and strategy docs, also kept current:
- [`docs/agora/RESEARCH.md`](docs/agora/RESEARCH.md) — what's confirmed vs. unverified against official Agora docs.
- [`docs/strategy/PRODUCT_STRATEGY.md`](docs/strategy/PRODUCT_STRATEGY.md) — problem-statement coverage matrix.
- [`docs/strategy/COMPETITIVE_ANALYSIS.md`](docs/strategy/COMPETITIVE_ANALYSIS.md) / [`INNOVATION_ROADMAP.md`](docs/strategy/INNOVATION_ROADMAP.md) — positioning and what to build next.

---

## 🎯 Capability Verification Matrix

Every capability in this repository is classified under one of six explicit statuses:

| Capability | Status | Description & Verification Evidence |
|---|---|---|
| **Deterministic Demo Mode (Identity Outage)** | `VERIFIED LOCALLY` | End-to-end scenario covering incident creation, 4 roles, fact/hypothesis extraction, conflict detection, action assignment, human approval/rejection, overdue check, and final summary. Verified by `test_demo_scenario.py`. |
| **PostgreSQL Persistence & Migrations** | `VERIFIED LOCALLY` | Real `postgres:16-alpine` Docker container tested. All 13 schema tables migrated, full entity persistence verified, and multi-process restart survival verified by `test_postgresql_live.py`. |
| **SQLite Fallback Database** | `VERIFIED LOCALLY` | Isolated local/test database fallback tested with clean fixtures via `test_intelligence.py`. |
| **Gemini LLM Structured Extraction** | `VERIFIED LIVE` | Uses `google-genai` SDK. Model ID is configurable via `GEMINI_EXTRACTION_MODEL` (default `gemini-3.7-flash`, released 2026-08-13) — Google retires model IDs on its own schedule, and a retired ID 404s into the heuristic fallback silently. `gemini-2.5-flash` was found retired live 2026-08-31; `gemini-3.6-flash` worked, then hit a 429 quota exhaustion the same day; `gemini-3.7-flash` is the current live-verified default. Verified live: `"I think the authentication database might be overloaded, but I have not confirmed that yet"` → `extraction_method: "llm"`, category `HYPOTHESIS`, evidence status `ASSUMED`. Falls back to `heuristic_fallback` (always `UNVERIFIED`, never `CONFIRMED`) on quota exhaustion, missing key, or model retirement. |
| **Canonical Voice Ingestion Pipeline (`/` dashboard)** | `VERIFIED LOCALLY` | Transcripts posted to `/api/incidents/{id}/observations` → structured extraction → PostgreSQL persistence → WebSocket broadcast → UI panels. This is the real pipeline and is what the root `/` dashboard uses. |
| **`/voice-test` Chat Reply** | `VERIFIED LOCALLY` | Typing a message now produces a real "TOCSIN" reply directly under the prompt via the actual `/observations` pipeline (not a simulated chatbot) — reports category, evidence status, extracted claim, and extraction method, with an explicit caveat when the reply came from heuristic fallback rather than the LLM. Bounded by a 12s server-side timeout (`GEMINI_EXTRACTION_TIMEOUT_SECONDS`) and a 20s client-side `AbortController` timeout, with a visible "TOCSIN is processing…" state — the chat cannot hang silently. Live-verified 2026-08-31, including the exact hang scenario the timeout exists to prevent. The right-hand "Incident Command" tiles on this page still use a disconnected client-side simulator — see `TODO.md` item 1. |
| **Contradictory Claim Conflict Detection** | `VERIFIED LOCALLY` | Flags opposing health polarity or numeric divergence >20% on the same entity, and generates a recommended verification action. Deliberately conservative: complementary detail about one entity ("returning 503" + "elevated latency") is **not** reported as a contradiction. 7 precision unit tests in `test_evidence_lifecycle.py`. |
| **Evidence Resolution Lifecycle** | `VERIFIED LOCALLY` | Contradictions, information gaps, and risks are closable by a named human with stated evidence (`POST .../conflicts/{id}/resolve`, `.../missing-info/{id}/resolve`, `.../risks/{id}/resolve`). Resolution is terminal (409 on re-resolve) and requires both `resolved_by` and `resolution_notes`. Tocsin records *that* a human settled a contradiction — never *which side was right*. `test_evidence_lifecycle.py`. |
| **Claim Provenance Trace** | `VERIFIED LOCALLY` | `GET .../claims/{id}/provenance` returns claim → originating observation → raw utterance → speaker → role and whether that role was declared or inferred → extraction method + caveat → related conflicts. Answers "why do we believe this?" without re-reading the transcript. |
| **Shift Handoff Brief** | `VERIFIED LOCALLY` | `GET .../handoff` produces a written record and a spoken script from the same evidence, ordered by what an incoming commander needs: confirmed, reported-only, unresolved contradictions, open questions, ownership (overdue flagged), remaining risks, plus disclosure of what share of the record came from heuristic fallback. Text only — **not broadcast as audio**. |
| **Human Approval & Action Safety** | `VERIFIED LOCALLY` | Strict state machine: `PENDING_APPROVAL` → `APPROVED` (requires `TOCSIN_COMMANDER_KEY`, HTTP 503 if missing). Rejections are terminal (`REJECTED`). Duplicate approvals return HTTP 409 Conflict. `/resolve` is auth-gated. |
| **Overdue Action Follow-up & Reminders** | `VERIFIED LOCALLY` | Action items track `due_at` and `owner_name`. Background in-process scheduler and `/check-reminders` endpoint emit `FOLLOWUP_REMINDER` events with 60-second cooldown spam throttling. |
| **Evidence-Bounded Final Summary** | `VERIFIED LOCALLY` | Generates structured incident summaries distinguishing confirmed facts from unverified intelligence, with mandatory AI root-cause disclaimer. |
| **Spoken Audio Summary Broadcast** | `NOT IMPLEMENTED` (text only) | Summary and handoff **text** is generated from persisted state and marked ready for TTS. Tocsin does **not** speak it into the room: Agora's `/speak` broadcast endpoint exists but is not called by this build. Previously labeled "credential required"; that overstated it — the audio path is not wired at all. See `docs/strategy/INNOVATION_ROADMAP.md` §2.1. |
| **Agora ConvoAI Gemini Live Agent** | `IMPLEMENTED — CREDENTIAL REQUIRED` | Agora RTC token generation and agent start/stop lifecycle implemented (`test_agora_token.py`). Live voice room requires active Agora credentials and microphone access. Agent status is read from Tocsin's own local session registry (`/api/agora/local-agent-session/{channel}`), not a live Agora query — see `docs/agora/RESEARCH.md`. |
| **MCP Tool Calling During Live Voice Sessions** | `NOT IMPLEMENTED` (confirmed unsupported) | The 13 emergency-intelligence tools are real and independently callable (`mock-services/server.py`). But Agora's official release notes state `mcp_servers` is supported **only under `llm`, not under `mllm`** — and Tocsin uses the `mllm` (Gemini Live) pipeline. The field Tocsin sends is not a supported field, so the voice agent cannot invoke these tools mid-call. Enabling this requires migrating to the `llm` pipeline. See `docs/agora/RESEARCH.md` §4. |
| **Slack Webhook Integration** | `VERIFIED LOCALLY` (Contract) / `IMPLEMENTED — CREDENTIAL REQUIRED` (Live) | Local HTTP webhook contract tested for 200 delivery (`LIVE_EXTERNAL`), 500 failure handling, timeout handling, and no-credentials mock fallback (`MOCK_FALLBACK`). Live Slack delivery requires `SLACK_WEBHOOK_URL` and has not been exercised against a real Slack workspace in this repository's verified runs. |
| **PagerDuty / Jira / Production Cloud Tooling** | `MOCK/DEMO ONLY` | Simulated emergency MCP tools and mitigation actions for the identity-outage demo scenario. No live PagerDuty, Jira, or cloud-provider execution exists in this repository. |

---

## 🚀 10-Minute Mentor Demo Script

Follow these steps to demonstrate all capabilities to a mentor or judge in under 5 minutes:

### Prerequisites
```bash
# 1. Start Docker PostgreSQL (required for production persistence)
docker compose up -d postgres

# 2. Start Tocsin Backend (Port 8000)
cd backend
source ../.venv/bin/activate
uvicorn app.main:app --reload --port 8000

# 3. Start Tocsin Frontend (Port 3000)
cd ../frontend
npm run dev
```
Open **`http://localhost:3000`** in your browser.

---

### Demo Step-by-Step Walkthrough

1. **Observe Demo Mode Banner & System Status**:
   - At the top of the dashboard, notice the `[DEMO MODE]` control banner with status indicators: **Postgres Ready**, **Gemini Optional**, **WebSocket Sync**.

2. **Trigger 1-Click Identity Outage Scenario**:
   - Click the **`⚡ Run Identity Outage Scenario`** button.
   - **What to Observe**:
     - Incident updates to `Customer Login and Identity Outage` (Severity: `CRITICAL`).
     - **4 Participants Join**: Commander Sarah Chen (Commander), Dave Miller (Engineer), Priya Sharma (Support), Marcus Vance (Business Lead).
     - **Live Observation Stream** populates with 6 multi-party voice utterances.
     - **Confirmed Facts**: Shows `login api: 40% 503 failure rate`.
     - **Contradictory Claims**: The Conflict Panel immediately flags:
       > *Dave Miller: "authentication database may be overloaded"*
       > vs
       > *Priya Sharma: "database connections: normal and healthy"*
       > *Recommended Action: Compare deployment timestamps with identity-service telemetry.*
     - **Missing Information**: Flags `Authentication error rates before and after the latest deployment`.
     - **Action Items**: Displays `Compare authentication error rates before and after deployment` assigned to **Dave Miller** with 5-minute due timer.
     - **Human Approval Demonstration**:
       - Safe Action `rollback_identity_deployment` approved and verified.
       - Dangerous Action `flush_all_production_databases` rejected by Commander (terminal, blocked from execution).
     - **Final Summary Report**: Synthesizes facts, decisions, actions, and unresolved risks with the mandatory AI disclaimer.

3. **Simulate Live Transcript Injection**:
   - In the **Simulate Utterance** form, select `Dave Miller (Engineer)`.
   - Type: *"Identity login errors are dropping after the deployment rollback."*
   - Click **`Inject Observation`**.
   - **What to Observe**:
     - The utterance is ingested into the backend observation pipeline, persisted to PostgreSQL, and broadcast over WebSockets to the Live Observation Stream.

4. **Test Overdue Reminders & Action Completion**:
   - Click **`⏰ Scan Overdue Action Reminders`**.
   - Click **`Complete`** on Dave Miller's action item to verify manual task resolution with evidence.

5. **Voice HUD & Agora Voice Room** *(Optional with Microphone)*:
   - Navigate to `/voice-test` to test Agora ConvoAI voice room integration, Silero VAD speech detection, and microphone streaming.

---

## 🧪 Automated Verification Suite

Run all test suites locally:

### Backend Suite (39 Tests across 9 Suites)
```bash
cd backend
source ../.venv/bin/activate
python -m pytest tests/ -v
```
**Test Coverage**:
- `test_demo_scenario.py`: Identity Outage scenario end-to-end, transcript simulation, reminder endpoints.
- `test_postgresql_live.py`: Real Docker PostgreSQL migrations, health check, entity persistence, multi-process restart survival.
- `test_gemini_extraction_live.py`: Live Gemini structured extraction & graceful quota fallback.
- `test_slack_integration.py`: Webhook HTTP contract tests (200, 500, timeout, mock fallback).
- `test_overdue_followup.py`: Action item overdue reminder emission and throttling.
- `test_security_and_state_machine.py`: Commander key authorization, terminal rejections, 409 duplicate conflicts.
- `test_agora_token.py`: Agora token generation and ConvoAI agent lifecycle.
- `test_simulation_engine.py`: Degradation loops, recovery lifecycle, and WebSocket streams.
- `test_intelligence.py`: Observation deduplication, participant mapping, conflict detection, and SQLite isolation.

### Frontend Suite (16 Unit Tests & Production Build)
```bash
cd frontend
npm test
npm run build
```

---

## 🔒 Security & Architecture Mandates

1. **Human Confirmation Mandate**: Critical recovery operations cannot execute autonomously. All emergency actions require explicit Incident Commander approval with `TOCSIN_COMMANDER_KEY` (HTTP 503 returned if unconfigured).
2. **Canonical Extraction Flow**: Browser voice transcripts post directly to `/api/incidents/{id}/observations`. Intelligence is extracted and persisted on the backend before broadcasting via WebSockets.
3. **No Phantom Integrations**: Fallbacks, simulated tools, and mock endpoints are transparently labeled with their exact operational classification.

---

## ⚠️ Honest Capability Status

Tocsin is **a reliable, evidence-bounded prototype with a production-oriented
architecture** — not a production-ready system. Nothing in this README should be read
as a production-readiness claim. In particular:

- Live MCP tool execution during an active Agora Gemini Live voice call is
  **unverified against official Agora documentation** and is labeled `MOCK/DEMO ONLY`
  above until a real, credentialed session demonstrates it working.
- Live Slack, PagerDuty, and Jira delivery require real external credentials that have
  not been exercised in this repository's verified test runs; treat those integrations
  as contract-tested or mock, not production-proven.
- See `docs/agora/RESEARCH.md` for the full Agora-specific research, including which
  parts of the ConvoAI/Gemini Live integration match official documentation and which
  do not.
