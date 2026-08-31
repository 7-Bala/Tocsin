# Tocsin — Innovation Roadmap

Every item states the incident-response benefit and a verifiable implementation path.
Items with no practical benefit are recorded in the rejected list rather than quietly
kept as "maybe". Nothing here may be described in a demo as working until it is.

Status: `DONE` (implemented + tested this pass) · `NEXT` (clear path, high value) ·
`LATER` (valuable, blocked or expensive) · `REJECTED` (deliberately not doing).

---

## Horizon 1 — Evidence accountability `DONE`

The theme: an evidence record is only trustworthy if items can be *closed by a named
human*, and if any displayed claim can be *traced back to what was actually said*.

| Item | Benefit | Verification |
|---|---|---|
| Conflict resolution with attribution | A contradiction the room settled verbally can be closed in the record, so the panel reflects genuine open work instead of accumulating stale alarms | `test_evidence_lifecycle.py::test_conflict_resolution_with_attribution_and_terminal_semantics` |
| Missing-info + risk resolution | Same lifecycle for information gaps and risks | `test_missing_info_and_risk_resolution` |
| Terminal resolution (409 on re-resolve) | Prevents a settled question being silently reopened or double-attributed | same test |
| Mandatory attribution + reasoning | An audit trail that records *that* something was settled but not *who* or *why* is not an audit trail | `test_resolution_requires_attribution_and_reasoning` |
| Claim provenance endpoint | Answers "why do we believe this?" — the sourced requirement that responders will not act on unverifiable conclusions | `test_claim_provenance_returns_full_chain` |
| Conflict-detector precision fix | A detector that cries wolf destroys trust in the whole record | 7 unit tests incl. `test_complementary_detail_is_not_a_conflict` |
| Dual-channel handoff brief | Targets a specifically-documented failure: verbal handoff is lost, written handoff is unacknowledged | `test_handoff_brief_structure_and_spoken_form`, `test_handoff_moves_conflict_from_open_to_settled_after_resolution` |
| Record-quality disclosure in handoff | An incoming commander must know what share of the record came from heuristic fallback rather than LLM extraction | `test_handoff_discloses_heuristic_fallback_share` |

---

## Horizon 2 — Closing the voice loop `NEXT`

Tocsin currently *listens* well and *writes* well. It barely *speaks*. Problem-statement
item 11 (spoken summaries) is the weakest coverage in the product.

### 2.1 Broadcast the handoff brief as real audio — `NEXT`, highest value

**Benefit:** makes handoff genuinely dual-channel. Right now `spoken_brief` is text a
human must read aloud themselves; Tocsin generated the words but cannot say them.

**Path:** Agora documents a "Broadcast a message using TTS" (`/speak`) REST endpoint
on a running agent. Call it with `spoken_brief`.

**Blocked on:** exact request schema could not be extracted from the docs site via
automated fetch (see `docs/agora/RESEARCH.md`), and verification requires a live
credentialed room. **Do not claim this works until a real session confirms it.**

### 2.2 Migrate transcript ingestion to RTM — `NEXT`

**Benefit:** removes the single largest correctness unknown in the product. The
current decoder's wire format is empirical and unconfirmed by any current Agora doc.

**Path:** Agora v2.9 moved transcript and agent-state delivery to RTM messages. Adopt
that path; keep the existing decoder as a labeled fallback.

**Verification:** capture one real payload as a fixture, then assert against it —
converting `agoraStreamDecoder.ts` from `UNVERIFIED` to evidence-backed.

### 2.3 Push evidence context into the live agent — `LATER`

**Benefit:** the voice agent could answer "what's still unresolved?" from the actual
record rather than from conversational memory.

**Path:** Agora's `/think` custom-instruction endpoint injects text into the live
conversation pipeline. Periodically push a compact open-items digest.

**Risk to manage:** this puts model-generated speech closer to authoritative-sounding
claims. Any such injection must be framed as "the record says", never "I determined".

---

## Horizon 3 — Depth in the evidence model `LATER`

### 3.1 First-class decisions with rationale and supersession

**Benefit:** today a decision is a `Claim` with `claim_type=decision`. Real incidents
need *"we decided X because Y at T1, superseded by Z at T2"*. Without supersession, a
handoff can hand over a reversed decision as current.

**Path:** a `Decision` model with `rationale`, `decided_by`, `supersedes_id`,
`superseded_by_id`; surface the active chain in handoff and final summary.

### 3.2 Assumption decay

**Benefit:** an assumption stated at minute 3 and never revisited is a silent risk. A
30-minute-old `ASSUMED` claim still driving the investigation should be re-surfaced.

**Path:** age `ASSUMED` claims; when one exceeds a threshold and is still referenced by
an open action, raise a missing-information item asking for confirmation.

`HYPOTHESIS` This is genuinely novel relative to what the reviewed competitors
describe, and it directly serves "distinguishes facts from assumptions" — but it needs
tuning against real transcripts to avoid becoming nagging.

### 3.3 Ownership gaps as detectable items

**Benefit:** the most common real failure is not a wrong decision, it is an action
nobody owns. Tocsin already knows which action items have `owner_name = None`.

**Path:** surface unowned actions as a distinct alert class in handoff and final
summary. Cheap; high operational value.

---

## Horizon 4 — Organisational scale `LATER`

### 4.1 Multi-incident overview

**Benefit:** during a broad outage, several incidents run concurrently and share
evidence. A commander needs to see them together.

**Deliberately deferred:** `CLAUDE.md` records this as future work, and single-incident
depth is worth more to judging than breadth. Do not start until Horizons 1–2 are solid.

### 4.2 Cross-incident evidence linking

**Benefit:** "this same contradiction about the auth DB appeared in last week's
incident."

**Blocked on:** requires a historical corpus. `FACT (SOURCED)` incumbents already do
similar-incident correlation well; competing here is a poor use of effort.

---

## Rejected — with reasons

| Item | Why rejected |
|---|---|
| Autonomous root-cause determination | Violates the core design stance and is the exact failure mode Tocsin differentiates against. Permanent rejection. |
| Avatars / video agent (Agora v2.7+) | Visually impressive, zero incident-response benefit. Textbook cosmetic complexity. |
| Filler phrases for "natural" agent speech | Optimises for conversational smoothness in a context where precision matters more than warmth. |
| Unexplained confidence percentages in the UI | Implies calibrated rigour we cannot substantiate. Evidence status (CONFIRMED/REPORTED/ASSUMED) is meaningful; "87%" is not. |
| Sentiment / stress analysis of responders | Surveillance-adjacent, ethically fraught, no clear operational action attached. |
| Auto-resolving conflicts by trusting the "more authoritative" speaker | Would make Tocsin adjudicate truth. The entire product thesis is that it must not. |
| Predicting incident duration / severity | Unfalsifiable during the incident, and being confidently wrong about ETA is worse than silence. |
| Gamified MTTR leaderboards | Actively harmful — incentivises premature incident closure. |

---

## Sequencing recommendation

1. **Horizon 2.2 (RTM transcripts)** before 2.1 — a spoken summary built on an
   unverified transcript path compounds one unknown with another.
2. **Horizon 2.1 (`/speak`)** next — it closes the last partially-met problem-statement
   requirement and makes the handoff differentiator complete.
3. **Horizon 3.3 (ownership gaps)** as a cheap high-value filler — hours, not days.
4. **Horizon 3.1 (decisions)** when there is time for a model change.
5. Everything else only after the above are verified.
