# Tocsin — Working TODO

Auto-maintained by Claude: an entry is added when work is identified, and deleted
(not just checked off) the moment it's actually done and verified — not when I claim
it's done. Do not treat an entry's presence here as "not started"; check the note for
current state. This file is the resume point after any session/context reset.

Last updated: 2026-08-31 (real-Chrome mic/tile verification; timeline-spam bug found, fixed, and live-verified).

---

## P0 — Breaks the demo / actively misleading

None open right now.

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

### 9. Demo incident's timeline unexpectedly reset around a backend restart (2026-08-31, cause unconfirmed)
**Status:** observed once, root cause not found — flagged rather than silently ignored.
While verifying the `FOLLOWUP_REMINDER` dedup fix (item above), `inc-demo-identity-outage`'s
timeline dropped from 132 events to 7 (matching the base identity-outage demo scenario's
seed shape), and the one action item's `due_at` was set to exactly 5 minutes after the
reset timestamp — the signature of `/api/demo/identity-outage/run-all` being called
fresh. This happened right around a `docker compose up -d --build backend` restart, but
nothing in `main.py`'s lifespan shutdown/startup or `simulator.shutdown()` re-seeds
data, and no deliberate call to that endpoint was made in that turn. Not chased further
since it didn't block the actual fix being verified (all tests independent of it) and
Postgres data itself was not wiped (74 other incidents survived). Possible causes not
ruled out: a stale browser tab from earlier in the session reconnecting and triggering
something on the frontend, or a manual re-run the user or another process performed
outside this conversation. Watch for recurrence.

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

- ✅ **`FOLLOWUP_REMINDER` timeline duplication fixed and live-verified** (2026-08-31).
  Root cause: `check_and_remind_overdue_actions()` (`backend/app/engine/simulator.py`)
  correctly throttled the reminder *broadcast* to once per 60s per item, but every one
  of those throttled firings still wrote a brand-new persisted `TimelineEntry` — an
  item that stayed overdue for an hour produced ~60 duplicate rows (found live via the
  real-Chrome test above: one demo incident reached 132 timeline events, the large
  majority identical). Fix: track `was_already_overdue` (the item's status before this
  check) — only the first transition into `OVERDUE` writes a timeline entry; every
  subsequent throttled reminder still fires the live WebSocket nudge (an active
  commander keeps getting reminded) but no longer duplicates the persisted record.
  Regression test added (`test_repeat_overdue_reminders_do_not_duplicate_timeline_entries`)
  that backdates `last_reminder_at` to simulate the throttle window elapsing five times
  in a row without sleeping in the test, asserting exactly one timeline entry survives.
  **Live-verified against the real running backend** (not just tests): polled the demo
  incident every 10s across the item's actual due time and past two 60s throttle
  windows — count went `0 → 1` at the due time and **stayed at 1** for the next ~100
  seconds, while `last_reminder_at` kept advancing (proving the live ping mechanism is
  still active, not accidentally disabled). 57/57 backend tests pass, `git diff --check`
  clean.
- ✅ **Real-Chrome verification session** (2026-08-31): opened `/voice-test` in the
  actual Chrome browser (not the sandboxed pane) specifically to exercise real
  microphone permission. Confirmed live: Agora RTC connected for real
  (`Voice: Connected`), and the console showed `VAD | debug > started micVAD`, which
  only appears after the browser's actual `getUserMedia()` mic permission succeeded —
  proof the real audio pipeline works, not just the UI. Did not start the paid Gemini
  Live agent (separate billed action, held pending explicit go-ahead). Verified the
  dynamic-tiles mechanism by typing observations: one phrasing ("surged to 300")
  produced no new tile, which turned out to be **correct** behavior, not a bug — the
  backend's heuristic fallback extractor (Gemini was unreachable at the time) genuinely
  extracted zero claims for that exact phrasing (confirmed via direct API check, not
  guessed). A second phrasing the extractor recognizes ("is down and unresponsive")
  produced a brand-new tile live, correctly toned red/unhealthy, correctly flagged
  "Unverified (heuristic)", with the overflow counter updating from "+2" to "+3" — no
  page refresh. Zero console errors throughout.

- ✅ **`/voice-test`'s disconnected client-side simulator fully replaced with real
  backend data — all 6 rollout steps of
  [`docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md`](docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md)
  complete and live-verified** (2026-08-31). The actual scope turned out larger than
  the plan originally estimated: `extractIncidentInfo()` (the ~200-line regex
  simulator with hardcoded flood/fire/earthquake/cyclone patterns) didn't just drive
  4 metric tiles — it also drove the incident header (title/location/severity/status),
  "Possible Causes," "Incident Timeline," and "Response & Actions," all via the same
  fake local state. All four are now sourced from the real `IncidentState` via the
  shared `useIncidentState` hook (step 1). "Response & Actions" specifically changed
  from fake local confirm/reject buttons that never called any backend endpoint to a
  **read-only** view of real `proposed_actions` with their real approval-workflow
  status, pointing to the main dashboard's already-implemented, commander-key-gated
  approval flow for taking action — judged a better fix than wiring a second,
  parallel authenticated-action surface into this page. The "Reset Incident" button
  (which cleared fake local state) became "Clear Transcript" (clears only the local
  chat display; the real backend evidence record is never touched by this page).
  **Live-verified end-to-end via the accessibility tree** (screenshots were flaky due
  to an unrelated browser-pane rendering issue this session, not an app bug — a fresh
  tab confirmed it): real title "Customer Login and Identity Outage," real event type,
  real incident ID, real severity/status/start time, 6 real dynamic tiles (with an
  honest "+2 more entities tracked" overflow note), a real hypothesis
  ("Identity-Service Deployment Regression," 88%), the real timeline, and the real
  demo-scenario actions — "rollback identity deployment: APPROVED" and "flush all
  production databases: REJECTED" — exactly matching what the human-approval
  demonstration in the demo scenario actually did. Zero flood/fire/earthquake
  vocabulary reachable anywhere on the page anymore. `git diff --check` clean, tsc
  clean, 56/56 backend tests pass, 43/43 frontend tests pass, build succeeds
  (`/voice-test` net shrank from 25.5 kB dark-launch size to 21.3 kB after the ~200
  dead lines were actually deleted). One accepted limitation carried forward from
  step 3: tile entity grouping is exact-match, not the backend's fuzzy substring
  match, so near-duplicate entity phrasings can render as separate tiles — a quality
  refinement, not a fail-proof violation.
- ✅ New finding surfaced by this verification, not yet fixed: the timeline had 120
  events, almost all duplicate `FOLLOWUP_REMINDER` spam — see the new P0 item above.

- ✅ **Root cause of the database-pollution item found and fixed: test isolation was
  silently broken, not merely "missing cleanup"** (2026-08-31). `conftest.py`'s
  autouse fixture intended to isolate every test to a temp SQLite file via
  `os.environ["USE_SQLITE_FALLBACK"] = os.getenv("USE_SQLITE_FALLBACK", "true")`. But
  `app/main.py` calls `load_dotenv()` at import time, loading `backend/.env` (real dev
  config: `USE_SQLITE_FALLBACK=false`) *before* the fixture ever runs — `os.getenv`
  with a default only fills in an *unset* var, so it silently preserved "false" instead
  of forcing isolation. Every local pytest run was hitting the real dev Postgres
  database directly. Confirmed live: incident count grew 149 → 185 → 222 across a
  handful of runs this session alone. Fixed by forcing
  `os.environ["USE_SQLITE_FALLBACK"] = "true"` unconditionally in the fixture.
  `test_postgresql_live.py` (which genuinely needs real Postgres) is unaffected — it
  has its own autouse fixture that runs after and re-forces Postgres explicitly.
  Verified live: a full 56-test run now adds ~22 rows (only from the 4 tests that are
  *supposed* to hit real Postgres) instead of ~70+ from the whole suite, and completes
  in ~19s instead of 2+ minutes.
- ✅ **One-time cleanup of the accumulated pollution** (2026-08-31): added
  `backend/scripts/cleanup_test_incidents.sql` (manual, not auto-run by anything —
  deleting incident data should never be a side effect of an automated process) and
  ran it once against the dev database. 222 rows → 1 (the canonical demo incident).
  Confirmed live after a backend restart (the in-memory `simulator._incidents` cache
  needed reloading — a direct SQL delete doesn't invalidate it) that `/api/incidents`
  correctly shows just `inc-demo-identity-outage`, and that its full evidence record
  (9 claims, 1 conflict) survived untouched.
- ✅ **Fixed: one persisted incident row could not be deserialized** (2026-08-31, found
  and closed same day). Root cause confirmed: `inc-demo-payment-outage` (title "Major
  Payment Processing & Checkout Outage") — the pre-pivot demo scenario — was still in
  the database with `event_type='PAYMENT_OUTAGE'`, a value removed from the enum in an
  earlier session. Every backend boot logged
  `ERROR tocsin.repositories - Failed to deserialize incident row` and silently
  dropped that row from the loaded set. Fixed with a proper migration
  (`003_remove_payment_outage_data.sql`) that deletes the row and all its dependent
  rows (conflicts, claims, observations, etc., in FK-safe order — no `ON DELETE
  CASCADE` is defined in the schema) rather than remapping its `event_type`, since the
  row's *title* is itself payment-outage content and CLAUDE.md prohibits that content
  existing anywhere, not just under a technically-different enum tag. Verified live:
  backend startup log no longer shows the deserialize error; `Loaded N persisted
  incidents` count matches the actual row count with zero silently dropped.

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
