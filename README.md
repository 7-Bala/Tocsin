# Tocsin — Real-Time Voice AI Incident Commander

Tocsin is a real-time AI Incident Commander platform designed for live incident command rooms. It joins incident discussions via voice audio or transcript ingestion, maintains a shared evidence record, separates confirmed facts from unverified assumptions, tracks key decisions, detects contradictory claims, manages action items with ownership and overdue follow-up, enforces strict human approval before emergency operational actions can execute, and generates evidence-bounded incident summaries with explicit AI disclaimers.

---

## 🎯 Capability Verification Matrix

Every capability in this repository is classified under one of six explicit statuses:

| Capability | Status | Description & Verification Evidence |
|---|---|---|
| **Deterministic Demo Mode (Identity Outage)** | `VERIFIED LOCALLY` | End-to-end scenario covering incident creation, 4 roles, fact/hypothesis extraction, conflict detection, action assignment, human approval/rejection, overdue check, and final summary. Verified by `test_demo_scenario.py`. |
| **PostgreSQL Persistence & Migrations** | `VERIFIED LOCALLY` | Real `postgres:16-alpine` Docker container tested. All 13 schema tables migrated, full entity persistence verified, and multi-process restart survival verified by `test_postgresql_live.py`. |
| **SQLite Fallback Database** | `VERIFIED LOCALLY` | Isolated local/test database fallback tested with clean fixtures via `test_intelligence.py`. |
| **Gemini LLM Structured Extraction** | `VERIFIED LIVE` / `VERIFIED LOCALLY` | Uses modern `google-genai` SDK (`gemini-2.5-flash`). Returns `extraction_method: "llm"` when quota is available. Automatically falls back to `extraction_method: "heuristic_fallback"` with status `UNVERIFIED` on 429 quota exhaustion or missing key. Verified by `test_gemini_extraction_live.py`. |
| **Canonical Voice Ingestion Pipeline** | `VERIFIED LOCALLY` | Agora & Web Speech transcripts post to `/api/incidents/{id}/observations` → structured extraction → PostgreSQL persistence → WebSocket broadcast → UI panels. |
| **Contradictory Claim Conflict Detection** | `VERIFIED LOCALLY` | Semantic entity matching and polarity/numeric divergence engine flags opposing statements (e.g., "100% pool exhaustion" vs "normal 22% CPU") and generates recommended verification actions. |
| **Human Approval & Action Safety** | `VERIFIED LOCALLY` | Strict state machine: `PENDING_APPROVAL` → `APPROVED` (requires `TOCSIN_COMMANDER_KEY`, HTTP 503 if missing). Rejections are terminal (`REJECTED`). Duplicate approvals return HTTP 409 Conflict. `/resolve` is auth-gated. |
| **Overdue Action Follow-up & Reminders** | `VERIFIED LOCALLY` | Action items track `due_at` and `owner_name`. Background in-process scheduler and `/check-reminders` endpoint emit `FOLLOWUP_REMINDER` events with 60-second cooldown spam throttling. |
| **Evidence-Bounded Final Summary** | `VERIFIED LOCALLY` | Generates structured incident summaries distinguishing confirmed facts from unverified intelligence, with mandatory AI root-cause disclaimer. |
| **Spoken Audio Summary Broadcast** | `IMPLEMENTED — CREDENTIAL REQUIRED` | Text synthesis is implemented and verified. Live voice broadcasting into active Agora channel requires configured Agora App ID / Certificate credentials and active room session. |
| **Agora ConvoAI Gemini Live Agent** | `IMPLEMENTED — CREDENTIAL REQUIRED` | Agora RTC token generation and agent start/stop lifecycle implemented (`test_agora_token.py`). Live voice room requires active Agora credentials and microphone access. Agent status is read from Tocsin's own local session registry (`/api/agora/local-agent-session/{channel}`), not a live Agora query — see `docs/agora/RESEARCH.md`. |
| **MCP Tool Calling During Live Voice Sessions** | `MOCK/DEMO ONLY` | The 13 emergency-intelligence tools are real and independently callable (`mock-services/server.py`), but wiring them into a live Agora Gemini Live voice agent (`properties.mllm.mcp_servers`) is **not confirmed by official Agora documentation** — Agora's docs describe `properties.llm.mcp_servers` instead, a pipeline MLLM mode disables. No live session has confirmed the voice agent actually invoking a tool this way. See `docs/agora/RESEARCH.md` §4. |
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
