# Tocsin — Working TODO

Auto-maintained by Claude: an entry is added when work is identified, and deleted
(not just checked off) the moment it's actually done and verified — not when I claim
it's done. Do not treat an entry's presence here as "not started"; check the note for
current state. This file is the resume point after any session/context reset.

Last updated: 2026-08-31 (live browser + API testing session).

---

## P0 — Breaks the demo / actively misleading

### 1. `/voice-test` chat never shows a Tocsin reply for typed input
**Status:** diagnosed, not fixed.
Confirmed live: typing into the command box (`handleCommandSubmit` in
`frontend/src/app/voice-test/page.tsx:940`) adds only the user's own message to the
transcript. `addTranscriptEntry('AI Agent', ...)` is called from exactly one place —
the live Agora `stream-message` handler (line ~861) — never from typed input. There is
currently no code path that generates or displays a Tocsin response to typed text.
**This is the user's core complaint** ("I want Tocsin's response visible under our
prompt") and it is not cosmetic — the feature does not exist yet for text input.
**Fix requires a decision:** either (a) call the real backend extraction pipeline
(`/api/incidents/{id}/observations`) and render its structured result as a reply
bubble ("Logged as REPORT, evidence status UNVERIFIED, entity: X"), or (b) route
typed text through Gemini for a conversational reply. (a) is more honest — it reflects
what Tocsin actually does — and reuses the already-tested extraction pipeline. Recommend (a).

### 2. `/voice-test` observation POST always 404s, silently
**Status:** diagnosed, not fixed.
Confirmed via network inspection: `handleCommandSubmit` posts to
`/api/incidents/${channelName}/observations` where `channelName` defaults to
`'tocsin-emergency-room'` — not a real incident ID. Every submission returns
`404 Not Found`, swallowed by `.catch(() => {})`. No error is ever surfaced to the
user or logged to the diagnostic panel. Same bug likely applies to the two other
fetch-and-catch call sites at lines ~864 and ~885 (voice stream ingestion).
**Fix:** use the actual selected incident ID (thread it in as a prop from `page.tsx`,
same as the main dashboard does), and log failures to `addLog(...)` instead of
silently discarding them.

### 3. `/voice-test` right-side "INCIDENT COMMAND" panel is a disconnected client-side simulator
**Status:** diagnosed, not fixed. This is the single biggest integrity gap found this session.
The tiles ("Customers Affected", "Gateway Error Rate", "Risk Level", "Service Health")
are populated entirely by `extractIncidentInfo()`, a ~200-line regex NLP function that
runs **only in the browser**, has zero connection to the real backend evidence engine
(`backend/app/engine/extraction.py` + `conflict_detector.py`), and still carries
leftover flood/fire/earthquake/cyclone disaster-response regex patterns from before
the identity-outage pivot (`frontend/src/app/voice-test/page.tsx` ~line 240 onward).
It "updates in realtime" but from fabricated client-side pattern matching, not from
Tocsin's actual intelligence pipeline — this directly risks the CLAUDE.md rule
"Never show stale flood or payment labels in the identity scenario," because the
underlying detector still contains those patterns and could surface them if triggered.
**Fix:** replace `extractIncidentInfo` + local `incidentData` state with the same
`IncidentState` the `/` dashboard already gets from `useIncidentWebSocket` /
`fetchIncident`. This is a real architecture change to a 2341-line file — needs its
own session, not a quick patch. Do NOT attempt as a drive-by edit.

### 4. Database has 149+ accumulated test/demo incidents
**Status:** diagnosed, not fixed.
`GET /api/incidents` returns 149 rows against the dev Postgres instance, including
dozens of `test-inc-*` and `inc-proc-restart-*` rows clearly left over from repeated
pytest runs against a real (not ephemeral) database. Not dangerous, but pollutes any
"list all incidents" UI and makes manual testing confusing.
**Fix:** either point the test suite at a dedicated test database/schema, or add a
teardown that deletes rows it created, or add a `docker compose` reset script. Flagged
in `CLAUDE.md`'s existing "Remove generated local database files from version control"
item — this is the live-database analogue of the same hygiene issue.

---

## P1 — Real but narrower

### 5. Spoken/audio summary broadcast not wired
**Status:** documented (`docs/strategy/INNOVATION_ROADMAP.md` §2.1), not implemented.
Agora's `/speak` REST endpoint is documented but never called. Text summaries and
handoff briefs exist; nothing makes Tocsin actually speak them into a live room.
Blocked on live Agora session + exact request schema (WebFetch couldn't extract it
last research pass — retry or find via SDK source).

### 6. Transcript ingestion may be reading a legacy Agora path
**Status:** documented (`docs/agora/RESEARCH.md`), not implemented.
Agora v2.9 moved transcript/agent-state delivery to RTM messages. Tocsin still reads
the RTC `stream-message` event with an empirical, doc-unconfirmed wire format. Migrate
and capture one real payload as a test fixture.

### 7. MCP tools cannot be invoked by the live Gemini Live voice agent
**Status:** confirmed and already labeled correctly everywhere (README, prompt,
`docs/agora/RESEARCH.md` §4) as `NOT IMPLEMENTED`. Not a bug — a documented, honest
limitation. Real fix requires migrating from the `mllm` pipeline to the `llm` pipeline
(architecture change, needs a live credentialed session to verify against). Listed
here only so it isn't lost, not because it needs urgent action.

---

## P2 — Smaller, cheap, queued

### 8. Unowned action items are not surfaced as a distinct alert
From `docs/strategy/INNOVATION_ROADMAP.md` §3.3. Cheap, high value — action items with
`owner_name = None` should raise a visible flag, not just render "unassigned" quietly.

### 9. Decisions have no rationale/supersession model
From `docs/strategy/INNOVATION_ROADMAP.md` §3.1. Decisions are currently plain claims;
a real incident needs "we decided X because Y, superseded by Z at T2."

---

## Recently completed (kept briefly for context, then deleted next pass)

- ✅ **Gemini model retirement fix** (2026-08-31): `gemini-2.5-flash` was retired by
  Google (404, "no longer available to new users"), silently degrading every
  extraction to the heuristic fallback. Live-tested `gemini-3.6-flash` (worked, then
  hit 429 quota exhaustion same day) and `gemini-3.7-flash` (released 2026-08-13,
  live-verified 200 OK). Default is now `gemini-3.7-flash`, overridable via
  `GEMINI_EXTRACTION_MODEL`. README updated to reflect live verification with an
  actual example (`HYPOTHESIS`/`ASSUMED` classification of "I think... but I have not
  confirmed that yet").
- ✅ **Dashboard hydration bug fixed and verified** (2026-08-31): `page.tsx` initialized
  `lastUpdated` with `new Date().toISOString()` directly in `useState`, which runs once
  during SSR and again during client hydration with a different value, causing React
  hydration errors #418/#423/#425 on every load of `/`. Confirmed via live browser
  console before and after: errors present pre-fix, zero console errors in a fresh tab
  post-fix, incident data loads correctly (`Telemetry: CONNECTED`, real metrics
  rendering). Fixed by lazy-initializing to `null` and setting the real timestamp
  client-side only.
- ✅ Evidence resolution lifecycle, claim provenance, handoff brief, conflict-detector
  precision fix — see `docs/strategy/PRODUCT_STRATEGY.md` §4 for detail (implemented
  and tested in the prior session, verified live end-to-end this session: demo run →
  handoff → resolve conflict → re-resolve 409 → handoff reflects settlement).
