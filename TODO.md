# Tocsin — Working TODO

Auto-maintained by Claude: an entry is added when work is identified, and deleted
(not just checked off) the moment it's actually done and verified — not when I claim
it's done. Do not treat an entry's presence here as "not started"; check the note for
current state. This file is the resume point after any session/context reset.

Last updated: 2026-08-31 (implemented + live-verified Tocsin chat replies).

---

## P0 — Breaks the demo / actively misleading

### 1. `/voice-test` right-side "INCIDENT COMMAND" panel is a disconnected client-side simulator
**Status:** fully planned, not yet implemented. Full design in
[`docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md`](docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md)
— architecture diagram, sequence diagram, tile-shape decision flowchart, tile-lifecycle
state diagram, an explicit fail-proof requirement + test per failure mode (backend
down, WS drop, empty claims, heuristic fallback, malformed claim, tile overflow,
rapid updates, conflicts), file-by-file component plan, and a 6-step rollout sequence.
Read that file before starting — do not re-derive the design from scratch.
Summary of the problem it solves: the tiles ("Customers Affected", "Gateway Error
Rate", "Risk Level", "Service Health") are populated entirely by `extractIncidentInfo()`,
a ~200-line regex NLP function that runs **only in the browser**, has zero connection
to the real backend evidence engine, and still carries leftover flood/fire/earthquake
regex patterns from before the identity-outage pivot. The plan's core fix: tiles must
be *derived* from whatever claims actually exist for the current incident (dynamic,
not a fixed 4-field template), sourced from the same `IncidentState` the `/` dashboard
already gets — not a second, drifting implementation.
Rollout is staged (extract shared hook → pure tile-derivation function + tests →
dark-launch alongside old panel → swap → delete old code → live verify) specifically
so this is not attempted as one large edit to a 2341-line file. Needs its own session.

### 2. Database has 149+ (now 185+) accumulated test/demo incidents
**Status:** diagnosed, not fixed, growing every test run.
`GET /api/incidents` returns 185 rows against the dev Postgres instance as of
2026-08-31 (was 149 earlier the same day), including dozens of `test-inc-*` and
`inc-proc-restart-*` rows clearly left over from repeated pytest runs against a real
(not ephemeral) database. Not dangerous, but pollutes any "list all incidents" UI and
makes manual testing confusing.
**Fix:** either point the test suite at a dedicated test database/schema, or add a
teardown that deletes rows it created, or add a `docker compose` reset script. Flagged
in `CLAUDE.md`'s existing "Remove generated local database files from version control"
item — this is the live-database analogue of the same hygiene issue.

### 3. One persisted incident row cannot be deserialized (data regression from removing PAYMENT_OUTAGE)
**Status:** newly found 2026-08-31, not fixed.
Backend logs on every startup:
```
ERROR tocsin.repositories - Failed to deserialize incident row: 1 validation error for IncidentState
event_type: Input should be 'WATER_CONTAMINATION', ... [type=enum, input_value='PAYMENT_OUTAGE', ...]
```
A prior session removed `PAYMENT_OUTAGE` from the `EventType` enum (correctly, per the
project's scenario rules) but did not account for an already-persisted row in the dev
database still carrying that value. That row is silently dropped from
`Loaded N persisted incidents` on every boot — it's not corrupting anything else, but
it is now permanently unreachable through the API until fixed, and the failure is only
visible in backend logs, not surfaced anywhere a developer would normally look.
**Fix:** either (a) add a data migration that remaps any `PAYMENT_OUTAGE` rows to
`TECHNICAL_INCIDENT` before the enum validation runs, or (b) since this is dev/demo
data with no production stakes, just delete that one row. (a) is more correct if this
pattern could recur with other enum changes.

---

## P1 — Real but narrower

### 4. Spoken/audio summary broadcast not wired
**Status:** documented (`docs/strategy/INNOVATION_ROADMAP.md` §2.1), not implemented.
Agora's `/speak` REST endpoint is documented but never called. Text summaries and
handoff briefs exist; nothing makes Tocsin actually speak them into a live room.
Blocked on live Agora session + exact request schema (WebFetch couldn't extract it
last research pass — retry or find via SDK source).

### 5. Transcript ingestion may be reading a legacy Agora path
**Status:** documented (`docs/agora/RESEARCH.md`), not implemented.
Agora v2.9 moved transcript/agent-state delivery to RTM messages. Tocsin still reads
the RTC `stream-message` event with an empirical, doc-unconfirmed wire format. Migrate
and capture one real payload as a test fixture.

### 6. MCP tools cannot be invoked by the live Gemini Live voice agent
**Status:** confirmed and already labeled correctly everywhere (README, prompt,
`docs/agora/RESEARCH.md` §4) as `NOT IMPLEMENTED`. Not a bug — a documented, honest
limitation. Real fix requires migrating from the `mllm` pipeline to the `llm` pipeline
(architecture change, needs a live credentialed session to verify against). Listed
here only so it isn't lost, not because it needs urgent action.

### 7. Gemini API latency is inconsistent in this environment — worth monitoring
**Status:** observed, mitigated (not "fixed" — the underlying cause is external).
Live-observed 2026-08-31: extraction latency ranged from ~1s to 173s across different
calls to the same model on the same day, with no error returned for the slow ones —
just an unbounded hang. The 12s timeout (item below, done) makes this safe rather than
silent, but repeated timeouts still mean users see the heuristic fallback (weaker
extraction) more often than they should. If this keeps happening, check whether it's
regional API routing, a Google-side incident, or something about this project's quota
tier — `GEMINI_EXTRACTION_TIMEOUT_SECONDS` can be raised if 12s turns out too
aggressive for a consistently-slower-but-still-working backend.

### 8. `onKeyDown={e => e.key === 'Enter' && handleCommandSubmit()}` did not fire during automated browser testing
**Status:** observed, not confirmed as a real bug.
Pressing Return via the browser automation tool did not submit the `/voice-test`
command input twice in a row, while clicking the send button worked reliably both
times. The code itself is correctly wired (`frontend/src/app/voice-test/page.tsx`
~line 2107). This may be a synthetic-keyboard-event quirk of the automation tool
(CDP-dispatched keydown not always reaching React's synthetic event system) rather than
an app bug — needs a human to actually press Enter in a real browser to confirm either
way before spending time "fixing" something that might not be broken.

---

## P2 — Smaller, cheap, queued

### 9. Unowned action items are not surfaced as a distinct alert
From `docs/strategy/INNOVATION_ROADMAP.md` §3.3. Cheap, high value — action items with
`owner_name = None` should raise a visible flag, not just render "unassigned" quietly.

### 10. Decisions have no rationale/supersession model
From `docs/strategy/INNOVATION_ROADMAP.md` §3.1. Decisions are currently plain claims;
a real incident needs "we decided X because Y, superseded by Z at T2."

---

## Recently completed (kept briefly for context, then deleted next pass)

- ✅ **Tocsin now replies in the `/voice-test` chat, live-verified end-to-end**
  (2026-08-31): `handleCommandSubmit` now awaits the real
  `/api/incidents/{id}/observations` response and renders a "TOCSIN" reply directly
  under the user's message — reporting category, evidence status, the extracted
  claim, extraction method (with an explicit caveat when it's heuristic fallback,
  never silently presented as equal to LLM output), and conflict/action-item/missing-
  info counts. This is a truthful readout of what the backend actually did, not a
  simulated personality. Verified live in the browser three times, including the
  exact scenario originally reported broken.
- ✅ **Root-cause fixed: `/voice-test` observation POST always 404'd, silently**
  (2026-08-31): default channel name was `'tocsin-emergency-room'`, not a real
  incident ID. Changed default to `'inc-demo-identity-outage'`, matching the
  convention the root dashboard's `VoiceHUD` already uses. Confirmed live: POST now
  returns `201`, not `404`.
- ✅ **Severe bug found and fixed: Gemini extraction call had no timeout and hung for
  up to 173 seconds with zero user feedback** (2026-08-31). This was the real reason
  the chat felt broken even after wiring the reply wiring itself — a request that
  never resolves produces no reply regardless of how correct the frontend code is.
  Added a 12s server-side timeout (`GEMINI_EXTRACTION_TIMEOUT_SECONDS`,
  `asyncio.wait_for` around the SDK call) with a distinct log message so a timeout is
  never confused with a code bug or a dead model, plus a 20s client-side
  `AbortController` timeout as defense in depth, plus a "TOCSIN is processing…"
  indicator with a disabled input/spinner so the UI is never silently frozen even
  during a fallback. Locked in with a deterministic regression test
  (`test_gemini_call_that_exceeds_timeout_falls_back_cleanly`) that doesn't depend on
  live API slowness to verify. Live-verified: a real call now either completes in
  ~1-12s or falls back cleanly at the 12s mark with a labeled, honest reply — never
  hangs.
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
