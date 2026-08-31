# Tocsin — Product Strategy & Implementation Assessment

Assessment date: 2026-08-31. Source of truth: the repository at this commit plus
exercised runtime behaviour. Nothing below is upgraded in status because it "should"
work; see `docs/agora/RESEARCH.md` for the same discipline applied to Agora.

---

## 1. Positioning

**Tocsin is the shared evidence record for a live incident room.**

Not a transcription bot (commoditised — see `COMPETITIVE_ANALYSIS.md` §1.2), not a
root-cause finder (rejected by design), not a monitoring dashboard (we hold no
telemetry of our own), not a ticketing system (we do not own workflow state of record).

One sentence: *Tocsin listens to an incident conversation and maintains a structured,
provenance-carrying record of what is confirmed, what is merely reported, what is
contradicted, and what nobody has checked — and refuses to convert any of those into
a conclusion on its own.*

### The design stance

> **Organize evidence without inventing certainty.**

This is the product. It is also the safety property: a system that never asserts a
root cause cannot be confidently wrong about one — which the sourced research
(`COMPETITIVE_ANALYSIS.md` §2.1) identifies as the failure that permanently destroys
responder trust.

---

## 2. Problem-statement coverage matrix

Hackathon problem statement requirements versus repository reality.

Status legend: `WORKS` (implemented and covered by a passing test) · `PARTIAL`
(implemented but incomplete for real use) · `SIMULATED` (deterministic demo data, not
live) · `CREDENTIAL` (implemented, needs external credentials to exercise) ·
`UNVERIFIED` (implemented, no runtime evidence it behaves correctly) · `MISSING`
(not implemented).

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 1 | Joins a live incident room | `CREDENTIAL` | Agora RTC join + ConvoAI agent lifecycle implemented (`backend/app/api/agora.py`, `VoiceHUD.tsx`). Token generation exercised live. Full room join needs credentials + microphone. |
| 2 | Listens to discussion | `CREDENTIAL` / `UNVERIFIED` | `stream-message` handler + `agoraStreamDecoder.ts`. Decoder wire format is empirical, not doc-confirmed. Agora moved transcripts to RTM in v2.9 — see `docs/agora/RESEARCH.md`. |
| 3 | Organizes shared understanding | `WORKS` | Observation → claim extraction → persistence → WebSocket → dashboard. `test_intelligence.py`. |
| 4 | Distinguishes facts from assumptions | `WORKS` | `EvidenceStatus` ontology (CONFIRMED/REPORTED/ASSUMED/UNVERIFIED/CONFLICTED). Heuristic fallback can never be CONFIRMED — enforced in `observations.py`. |
| 5 | Tracks decisions | `PARTIAL` | Decisions extracted as `ClaimType.DECISION` and surfaced. No dedicated decision object with rationale//reversal tracking. |
| 6 | Tracks action ownership | `WORKS` | `ActionItem` with owner, due_at, overdue scan, completion evidence. `test_overdue_followup.py`. |
| 7 | Detects conflicting information | `WORKS` (detection) | `conflict_detector.py` + `test_intelligence.py`. **Resolution added this pass — see §4.1.** |
| 8 | Detects missing information | `PARTIAL` → improved | Extracted and displayed. **Resolution added this pass — see §4.1.** |
| 9 | Maintains a timeline | `WORKS` | `TimelineEntry` appended on every material state change; persisted. |
| 10 | Operational tool integration | `SIMULATED` | 13 MCP tools in `mock-services/server.py` call real public APIs (USGS/NASA FIRMS/NOAA/OSM/Open-Meteo/GDACS/CAMS). Slack is contract-tested only. PagerDuty/Jira do not exist. |
| 11 | Spoken summaries | `PARTIAL` / `CREDENTIAL` | Summary *text* generated from persisted state and marked ready for TTS. Audio broadcast into a live channel is **not wired**; Agora exposes a `/speak` endpoint we do not call. |
| 12 | Human confirmation for critical actions | `WORKS` | Commander-key-gated approval, terminal rejection, 409 on duplicate approval. `test_security_and_state_machine.py`. |
| 13 | Final summary with unresolved risks | `WORKS` | `summaries.py` with mandatory AI disclaimer, evidence-bounded from persisted state. |

---

## 3. What was wrong, and why it mattered

Three findings from reading the code that materially undermined the product thesis.

### 3.1 Conflict detection produced false positives — `FIXED THIS PASS`

`conflict_detector._values_conflict()` ended with:

```python
# Values are clearly different strings → flag as potential conflict
if norm_a != norm_b and len(norm_a) > 0 and len(norm_b) > 0:
    return True
```

Any two *different* strings about the same entity were reported as a contradiction.
Concrete failure: "login api: returning 503" and "login api: 40% error rate" are
complementary observations from the same investigation, but were emitted as a
conflict demanding commander attention.

**Why it mattered more than a normal bug:** the entire product thesis is that Tocsin
is trustworthy because it does not overclaim. A conflict panel that cries wolf is
exactly the "confidently wrong" failure mode the research says destroys trust
permanently. This was the highest-severity issue in the repository.

### 3.2 The evidence lifecycle was write-only — `FIXED THIS PASS`

The `conflicts` table has `resolved_at` and `resolution_notes` columns. The
`ConflictRepository` had only `insert()`. Same for missing-information and risks.

So Tocsin could *raise* a contradiction but no human could ever *settle* it. During a
real incident the panel would accumulate permanently-open items — including ones the
team resolved verbally minutes later — making the record actively misleading about
what is still open.

`ASSUMPTION` This is the difference between a detector and a workflow. Detection
alone is a demo; resolution with attribution is a product.

### 3.3 Cross-scenario metric leakage — `FIXED THIS PASS`

`IncidentMetrics` carried `water_safety_index` and `flood_depth_meters`, rendered on a
technical identity-outage incident. `EventType` still contained `PAYMENT_OUTAGE`.
Both violate the project's own rule against fake telemetry and stale scenario labels.

---

## 4. Implemented this pass

### 4.1 Evidence resolution lifecycle

Contradictions, information gaps, and risks became closable objects with attribution:

- `POST /api/incidents/{id}/conflicts/{conflict_id}/resolve`
- `POST /api/incidents/{id}/missing-info/{info_id}/resolve`
- `POST /api/incidents/{id}/risks/{risk_id}/resolve`

Each requires a human resolver identity and stated resolution evidence, writes a
timeline entry, and broadcasts over WebSocket. Resolution is **not** available to the
AI — only a named human closes an evidence item. Re-resolving an already-resolved item
returns `409 Conflict` (same terminal-state discipline as action rejection).

### 4.2 Provenance trace — "why do we believe this?"

`GET /api/incidents/{id}/claims/{claim_id}/provenance`

Returns the full chain: claim → originating observation → raw utterance → speaker →
participant role and how that role was determined (declared vs inferred) → timestamp →
extraction method → any conflicts this claim participates in. This is the direct
answer to the sourced requirement that engineers will not act on conclusions they
cannot verify.

### 4.3 Shift handoff brief

`GET /api/incidents/{id}/handoff`

Generates a dual-channel handoff artifact targeting the specifically-documented
failure in `COMPETITIVE_ANALYSIS.md` §2.4 — structured JSON for the incident document
plus a spoken-form script for reading onto the bridge. Sections are ordered by what an
incoming commander needs first: what is confirmed, what is only reported, what is
actively contradicted and unresolved, what is unknown, who owns what (with overdue
flagged), and what remains at risk.

### 4.4 Conflict-detector precision fix

Removed the catch-all "different strings conflict" branch. A conflict is now raised
only on: opposing health polarity, or numeric divergence beyond a threshold on the
same metric. Everything else is treated as complementary evidence, not contradiction.

---

## 5. Explicitly rejected or postponed

Recorded so scope stays honest and the demo does not promise these.

| Item | Decision | Reason |
|---|---|---|
| Autonomous root-cause determination | **Rejected permanently** | Violates the core design stance; is the failure mode we differentiate against. |
| Live PagerDuty / Jira integration | **Postponed** | No credentials, no verification path in hackathon scope. Would become an unverifiable claim. |
| Historical incident correlation | **Postponed** | Requires a corpus we do not have. Incumbents do this well; competing here is a losing move. |
| Confidence percentages on the dashboard | **Rejected** | Unexplained numeric confidence is decorative and implies rigour we cannot substantiate. |
| Speaker diarization / voice fingerprinting | **Postponed** | Agora UID → participant mapping is sufficient and verifiable; diarization is a research project. |
| Multi-incident org overview | **Postponed** | Listed in `CLAUDE.md` as future work. Single-incident depth matters more for judging than breadth. |
| Avatar / video agent (Agora v2.7+) | **Rejected for this scope** | Visually impressive, zero incident-response benefit. Exactly the cosmetic complexity to avoid. |
| Calling Agora `/speak` for live audio summary | **Postponed, high value** | Real capability (see `docs/agora/RESEARCH.md`); needs credentials and a live room to verify. Would close problem-statement item 11. |

---

## 6. Immediate next priorities

1. **Wire the Agora `/speak` endpoint** to broadcast the handoff brief and final
   summary as actual audio. This closes the last partially-met problem-statement
   requirement and makes the handoff genuinely dual-channel.
2. **Migrate transcript ingestion to RTM** — Agora v2.9 moved transcript delivery to
   RTM messages; the current `stream-message` decoder is empirical and may be reading
   a legacy path.
3. **Capture a real stream payload as a test fixture** to convert the decoder from
   `UNVERIFIED` to evidence-backed.
4. **Decision objects with rationale and reversal** — currently decisions are claims;
   a real incident needs "we decided X because Y, superseded by Z at T."
