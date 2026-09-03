# Tocsin — Working TODO

Auto-maintained by Claude: an entry is added when work is identified, and deleted
(not just checked off) the moment it's actually done and verified — not when I claim
it's done. Do not treat an entry's presence here as "not started"; check the note for
current state. This file is the resume point after any session/context reset.

Last updated: 2026-09-03 (real Chrome connected with real mic access for the first
time this session — confirmed `/speak` actually produces audible output, not just
an accepted API call, by tapping the page's own audio analyser and catching a real
speech envelope; found and fixed a stale hardcoded "Gemini Live Agent" join-log
message that didn't reflect the actual running pipeline. Earlier this session:
installed Agora Skills on a mentor's recommendation and found the real root cause
of the long-standing "MCP tools get listed but never called" mystery (undocumented
"sse" transport instead of the documented "streamable_http") — fixed and
live-verified a genuine tool call, USGS earthquake API and all; wired and
live-verified real Agora agent-status/list endpoints; composed_tools now defaults
to Agora-managed OpenAI, keyless, live-verified; fixed a real honesty bug where
every new incident was seeded with a fabricated "Possible Cause" before any
evidence existed.).

---

## P0 — Breaks the demo / actively misleading

None open right now.

---

## P1 — Real but narrower

### 5. RTM transcript delivery — now producing correctly-labeled agent transcripts
**Status:** substantially more verified 2026-09-01. Root cause of the whole day's
"never works" pattern found: `agora-rtm` was declared in `package.json` but its
dynamic `import('agora-rtm')` had no logging around it and no timeout, so a stall
was indistinguishable from "still trying" — fixed with explicit step logging and a
10s timeout per call in `agoraRtmTranscripts.ts`. Live-verified in real Chrome with
a real microphone: a genuine agent response ("Logged as UNCLASSIFIED (UNVERIFIED)...")
appeared correctly labeled **TOCSIN**, not Field Operator — confirming
speaker-correct transcript delivery is working end-to-end, through either RTM or
the legacy stream-message fallback (both call the same labeling path; which one
fired specifically was not pinned down this pass due to console-log capture
unreliability in this environment — worth confirming precisely next session).

### 7. Gemini API latency is inconsistent in this environment — worth monitoring
**Status:** observed, mitigated (not "fixed" — the underlying cause is external).
Live-observed 2026-08-31: extraction latency ranged from ~1s to 173s across different
calls to the same model on the same day, with no error returned for the slow ones —
just an unbounded hang. The 12s timeout (item below, done) makes this safe rather than
silent, but repeated timeouts still mean users see the heuristic fallback (weaker
extraction) more often than they should. If this keeps happening, check whether it's
regional API routing, a Google-side incident, or something about this project's quota
tier — `GEMINI_EXTRACTION_TIMEOUT_SECONDS` can be raised if 12s turns out too
aggressive for a consistently-slower-but-still-working backend. No new finding this
pass: confirmed this is Google-side API behavior, not something this codebase causes
or can fix. Closing further local investigation here.

### 8. Demo incident's `/run-all` reset has happened at least twice — now explained
**Status:** most likely explained 2026-08-31, not a code bug. This machine runs
**multiple concurrent Claude Code sessions** against the same repo and the same
Docker backend on `localhost:8000` (confirmed via `ListAgents` — a peer session
`crius-1b` was independently active for hours during this work). Re-checked
everything the earlier investigation flagged as unresolved: no frontend
auto-trigger (`runIdentityOutageDemo` is only bound to a button `onClick`, never a
`useEffect`), no backend startup auto-call (`lifespan()` in `main.py` only loads
persisted state), no seed-on-migration (zero matches for the demo incident ID across
`backend/app/engine/migrations/*.sql`), 0 container restarts (ruling out a
crash-loop). Combined with the earlier finding (a reset happened with zero
`/run-all` requests in the *current* container's access log, yet the data was
already reset when that container loaded it from Postgres at startup) — the
straightforward explanation is a legitimate `/run-all` call from another session,
a prior instance of this session, or manual testing, whose evidence lived in a
*previous* backend container's logs (Docker doesn't persist those across a
rebuild, and this repo's backend image was rebuilt many times this session). Not a
bug to fix further; the warning log added earlier (`logger.warning(...)` in
`run_complete_identity_outage_scenario()`) stays in place so a *future* occurrence
is traceable in real time.

---

### 9. Agora `agent-update` — implemented, still not exercised live
**Status:** narrowed 2026-09-03. `POST /api/agora/agent-think` is now
**live-verified** — it was the mechanism used to trigger the MCP tool call in the
transport fix (Agora accepted the injection and the agent acted on it by calling a
tool). What remains is only `POST /api/agora/agent-update` (push a new system
prompt into a running agent without restarting it): wired per the confirmed schema
(`docs/agora/RESEARCH.md` §13), regression tested, curl-verified for the
404-no-agent path, but never called against a real running agent, so it is
unconfirmed whether Agora accepts it and whether the agent's later behavior
actually reflects the pushed prompt. Needs a live agent session (billed).


---

## P2 — Smaller, cheap, queued

None open right now.

---

## Recently completed (kept briefly for context, then deleted next pass)

- ✅ **Spoken audio summary broadcast (`/speak`) confirmed actually audible** (2026-09-03).
  Open since 2026-08-31 as the one remaining live gap: `/speak` was implemented and
  curl-verified for the 404 (no-agent) path, but real audio delivery had never been
  observed. Real Chrome + real mic connected this session; started a real agent,
  called `POST /api/agora/speak` against it, and Agora accepted it (HTTP 200,
  `"status": "spoken"`). Payload acceptance alone isn't proof of audible output, so
  verified further: temporarily tapped the page's own Web Audio analyser (already
  wired to the agent's real RTC audio track for the "AI speaking" UI indicator) via
  console injection, not a source change. Polled it through the broadcast window and
  got a real speech envelope — silent for ~3.9s (network + TTS synthesis latency),
  then `0 → 177 → 181 → 159 → 137 → 126 → 105` across the frequency spectrum, a clean
  attack/peak/decay shape, not noise. Cleaned up: agent confirmed `STOPPED` via the
  live agent-status endpoint, zero agents left running on the account afterward.

- ✅ **Groq fallback tier live-verified** (closed 2026-09-03, verified 2026-09-01 —
  the entry was simply left stale). Commit `4e5946a` records the actual live run:
  called `extract_with_groq()` against the real Groq API with a real key (response
  parsed, labeled `"llm"`), then verified the full `extract_intelligence()` chain by
  simulating a Gemini failure and confirming Groq picked up seamlessly. Gemini stays
  primary; Groq fires only when Gemini is unconfigured or fails (including quota
  exhaustion, which is the scenario it exists for).

- ✅ **`POST /api/agora/agent-think` live-verified** (2026-09-03). Used to inject a
  tool-triggering instruction into a real running agent during the MCP transport
  fix; Agora accepted the call and the agent acted on it. Item 9 narrowed to
  `agent-update`, which is still untested live.

- ✅ **Live Incident Map — the incident drawn as a graph as people speak**
  (2026-09-03). Built in response to the mentors' stated brownie-point criterion
  (generative UI reacting to the conversation, not just chat). Renders systems,
  proposed causes, and the links between them from the evidence record over the
  existing WebSocket. Honesty rules enforced in a pure, tested derivation module:
  nodes only where someone made a claim, edges only where a human's own hypothesis
  names that system, every edge dashed with a "?" and labelled "proposed link, not
  established", ruled-out causes kept and struck through, contradicted systems
  ranked first and shown split with both sources. Pure SVG, no graph library
  (~6 kB). Live-verified: posted an observation naming a new system and watched
  the map add it and flip its failing counter with no refresh. Light on
  `/voice-test`, dark on `/`. 19 new tests.

- ✅ **MCP tool invocation actually confirmed working — root cause of "lists tools,
  never calls one" found and fixed** (2026-09-03). This had been open since
  2026-08-31. Asked it directly in the live EchoSphere mentor Q&A; Nitin's answer
  was to install Agora Skills (`npx skills add AgoraIO/skills`) and consult it
  rather than guess. Its bundled reference for Agora's own official MCP server
  (`server-mcp.md`) mentioned "MCP Streamable HTTP protocol" — this project was
  sending `"transport": "sse"` against a `/sse` endpoint, neither of which is a
  documented value. Confirmed directly against Agora's own join-API docs: the
  `transport` field only documents one valid value, `"streamable_http"`. Fixed
  both sides of the connection together: `mock-services/server.py`'s
  `mcp.run(transport="sse", ...)` → `transport="http"` (FastMCP's Streamable HTTP,
  serving at `/mcp` not `/sse`), and `backend/app/api/agora.py`'s payload to match.
  **Live-verified end-to-end**: started a real `composed_tools` agent through a
  public ngrok tunnel to the corrected mock-services container, confirmed the
  Streamable HTTP handshake succeeded from Agora's real infrastructure, then used
  `POST /api/agora/agent-think` (also live-verifying TODO item 9 as a side effect)
  to inject an earthquake-activity question. Mock-services' log showed, for the
  first time ever, `Processing request of type CallToolRequest`, immediately
  followed by a real call to USGS's live earthquake API returning `200 OK`. Agent
  confirmed `STOPPED` afterward, ngrok torn down. Upgraded from `CREDENTIAL
  REQUIRED` to `VERIFIED IN CODE` in RESEARCH.md. `github.com/nitin4real/Dummy-MCP-SSE`
  was offered as a comparison reference but turned out unnecessary — the docs
  fetch alone found the exact cause.

- ✅ **Real Agora agent-status and account-wide agent-listing endpoints, live-verified**
  (2026-09-03). Mentor-provided contracts for two endpoints RESEARCH.md had flagged as
  unconfirmed, cross-checked against a direct fetch of Agora's own docs before wiring:
  `GET /api/agora/agent-status/{channel_name}` (real Agora status, not a local guess)
  and `GET /api/agora/agents` (account-wide listing, for finding zombie agents still
  burning managed-model minutes). Live-verified against the real account: started a
  real agent, got Agora's own `"RUNNING"` back, stopped it, got `"STOPPED"` with a
  `stop_ts`; the account-wide list correctly returned zero lingering agents.

- ✅ **`composed_tools` now defaults to Agora-managed OpenAI, needs zero model keys**
  (2026-09-03), per the EchoSphere organizers' stated preference for managed models.
  New `composed_tools_llm_vendor` field (`"openai"` default, `"gemini"` still
  available). Live-verified against the real Agora API: both vendor choices returned
  HTTP 200 with a real `agent_id` and Agora-reported `"RUNNING"`, confirmed stopped
  after cleanup. Wired into the `/voice-test` UI's Conversational Agent panel.

- ✅ **Fabricated "Possible Cause" removed from every new incident** (2026-09-03).
  `simulator.create_incident` seeded a Hypothesis ("Potential TECHNICAL_INCIDENT
  risk", 35% confidence) before any evidence existed — a direct violation of the
  project's "organize evidence without inventing certainty" principle, and visibly
  misleading on a completely fresh incident. Hypotheses now start empty.

- ✅ **Severe, more complete version of a bug found and fixed: `USE_SQLITE_FALLBACK`
  was NOT actually short-circuiting Postgres, so test runs were still silently
  writing into the real dev database for nearly this entire session** (2026-08-31).
  A `git diff --check` verification while working on item 9 surfaced live test
  incidents ("Decision Test", "Supersede Test") on the real dashboard, which should
  have been impossible after an EARLIER session's fix to `tests/conftest.py`
  (forcing `USE_SQLITE_FALLBACK=true`). Root cause found in
  `backend/app/engine/database.py`'s `init_db()`: it tried PostgreSQL FIRST
  whenever `DATABASE_URL` was set, regardless of the fallback flag — the flag was
  only ever consulted in the `except` branch, i.e. only if the Postgres connection
  attempt itself threw. Since Docker's Postgres was reachable for nearly this whole
  session, every test run connected to and wrote into the real database anyway.
  Confirmed live: 333 test-created rows had accumulated (330 before this pass, +3
  more from this pass before the fix landed) — only 1 (`inc-demo-identity-outage`)
  was genuine. Fixed by checking `use_sqlite_fallback` *before* ever attempting
  Postgres, making the flag authoritative rather than a same-process-failure-only
  fallback. Verified: a full pytest run after the fix (excluding
  `test_postgresql_live.py`, which intentionally targets real Postgres by design)
  added zero rows to the real database. Cleaned up via the existing
  `backend/scripts/cleanup_test_incidents.sql`, run three times because a
  concurrent session's already-running (pre-fix, in-memory) pytest process kept
  adding a few more rows between cleanup passes — a file edit doesn't affect a
  process that already has the old code loaded. Notified that session directly.
  Final state confirmed: exactly 1 row (`inc-demo-identity-outage`) in real
  Postgres. **This corrects, not merely supplements, the earlier "root cause fixed"
  claim for the same symptom** — the earlier fix was real but only handled the
  Postgres-unreachable case, which was the rarer case in practice.

- ✅ **First-class decisions with rationale and supersession** (2026-08-31, item 9,
  closes `docs/strategy/INNOVATION_ROADMAP.md` §3.1). `Claim` gained
  `rationale`/`decided_by`/`supersedes_id`/`superseded_by_id` (round-trips through
  the existing `state_json` JSONB blob — no migration needed, since that's the
  actual read path for `IncidentState.claims`, confirmed by reading
  `IncidentRepository.get`/`list_all`). Two new endpoints:
  `POST /api/incidents/{id}/decisions` (record, human-authored, not extracted —
  a decision needs its rationale attached at the moment it's made) and
  `POST .../decisions/{claim_id}/supersede` (409 if the target was already
  superseded, 404 if it doesn't exist or isn't a decision). Only the ACTIVE end of
  each chain is surfaced as current in the handoff brief and final summary — a
  superseded decision is kept as history in a separate section, never presented as
  still in force. Found and fixed a related leak while testing: a decision's
  `status=CONFIRMED` let it double-appear in the generic "Confirmed facts" list
  even after being superseded (that list's status filter didn't know about
  supersession); decisions are now excluded from it entirely since they have their
  own dedicated section. New `DecisionsPanel.tsx` (record + supersede UI, replacing
  the old read-only "Incident Decisions" tile which showed superseded decisions as
  if still current). 5 new backend tests, 2 new frontend tests — 69/69 backend,
  47/47 frontend, build succeeds. Live-verified end-to-end against the real running
  backend: recorded a decision, superseded it, confirmed the handoff brief showed
  only the new value as active, the old one only as superseded history and as
  supersession context on the new one, the spoken brief mentioned only the current
  decision, and re-superseding the already-superseded one correctly returned 409.

- ✅ **Spoken audio summary broadcast implemented for real** (2026-08-31). Earlier
  research passes couldn't extract the `/speak` endpoint's request schema via
  WebFetch (it kept returning a docs nav/index page instead of content); this pass
  found the working pattern — appending `.md` to the doc URL
  (`.../conversational-ai/speak.md`) returns the actual page content. Confirmed
  schema: `POST /v2/projects/{appid}/agents/{agentId}/speak`, body
  `{text, priority, interruptable}`, same Basic-auth scheme as `/join`/`/leave`.
  New `POST /api/agora/speak` (`backend/app/api/agora.py`) looks up the agent_id
  already tracked for a channel (404, not silent no-op, if none is running) and
  calls Agora's endpoint with the exact documented field names. Wired into a new
  "🔊 Broadcast" button on `HandoffPanel.tsx`'s spoken-script section, sending the
  same `spoken_brief` text the written and spoken handoff forms already share — so
  they still cannot drift apart, and the spoken form can now actually reach the
  room instead of only being copy-pasted. 2 new backend regression tests (outbound
  URL/JSON match the documented schema exactly; 404 when no agent is tracked) —
  66/66 backend tests pass. Frontend build and all 45 tests pass. Curl-verified
  against the real running backend and real Agora credentials: correct 404 for a
  channel with no active agent. **Not yet verified:** whether Agora's real
  endpoint accepts the call and audio is actually heard — requires an active
  agent (billed live session), tracked as the live-test step in the P1 item above.

- ✅ **RTM transcript transport implemented for real, replacing the empirical RTC
  `stream-message` path** (2026-08-31). Research revealed a larger scope than the
  item's original wording suggested: official docs confirm transcripts are
  delivered over Agora Signaling (RTM), not RTC, and require `enable_rtm`/
  `data_channel: "rtm"` on agent-join to actually select that transport — meaning
  this wasn't just "migrate the decoder," it was a new transport end-to-end.
  Agora's own reference implementation (the "ConversationalAIAPI toolkit") turned
  out not to be an npm package at all — its docs say to copy its ~2,700-line
  source into your project, and that source itself depends on an internal
  `@agora-js/report` package and a demo-app-specific file, i.e. it isn't cleanly
  vendorable. Reading that source directly (not running it) confirmed the real
  wire format: plain JSON RTM messages, `object: "user.transcription"` /
  `"assistant.transcription"`, no chunking/base64 — exactly what
  `agoraStreamDecoder.ts`'s existing "direct JSON" pattern already parses. Built
  a small first-party RTM transport (`frontend/src/lib/agoraRtmTranscripts.ts`)
  using the real `agora-rtm@2.3.0` npm package directly instead of vendoring the
  toolkit, reusing the existing decoder as the parser. Backend: new
  `POST /api/agora/rtm-token` (using `RtmTokenBuilder`, already present in the
  installed `agora-token-builder` package — no new Python dependency);
  `advanced_features.enable_rtm`/`parameters.data_channel: "rtm"` now sent on
  every `/start-agent` call for both pipelines. Frontend: wired into **both**
  `VoiceHUD.tsx` (used on `/`) **and** `voice-test/page.tsx`'s separate inline
  Agora client (used on `/voice-test` — discovered mid-implementation that these
  are two independent implementations, not shared code; both needed the change or
  `/voice-test`'s agent transcript would have silently gone dark once
  `data_channel: "rtm"` took effect). Old RTC `stream-message` listeners kept in
  both files as inert fallbacks. 3 new backend tests (RTM token issuance, missing-
  credential rejection, `enable_rtm`/`data_channel` present on payloads) — 64/64
  backend tests pass. Frontend build and all 45 tests pass. **Live-verified
  without a paid agent session:** `/api/agora/rtm-token` curl-verified against
  real Agora credentials (HTTP 200, well-formed token); in a real browser
  (sandboxed pane, real Agora RTC/RTM servers, no mic permission available there)
  RTC join succeeded against the live gateway
  (`Joining channel success: channel: inc-demo-identity-outage, uid: 9971`), the
  RTM token request returned HTTP 200, and RTM login/subscribe produced zero
  console errors before the sandbox's expected mic-permission denial. **Not yet
  verified:** whether a real speaking agent's transcript actually arrives in the
  assumed JSON shape — tracked as the live-test step in the P1 item above.

- ✅ **MCP tool-calling wired for real via a new opt-in `composed_tools` pipeline**
  (2026-08-31). Root research finding that made this possible: the join-API reference
  lists `llm.vendor` as `openai | azure | xai | custom` (Gemini not in the enum), while
  a *separate* dedicated Gemini-LLM docs page shows Gemini used via `style: "gemini"` +
  a raw URL/embedded key — resolved as `vendor: "custom"` + `style: "gemini"`,
  satisfying both pages and keeping Gemini as the reasoning model. `backend/app/api/agora.py`
  now branches on a new `voice_pipeline` field on `/start-agent`
  (`"gemini_live"` default — completely unchanged behavior — or `"composed_tools"`,
  the new path). `composed_tools` builds `asr` (Deepgram) + `llm` (Gemini, BYOK, our
  existing key) + `tts` (MiniMax) with `asr`/`tts` on `credential_mode: "managed"` so
  Agora bills those two hops itself — no new third-party API key added to the project.
  Real `llm.mcp_servers` + `advanced_features.enable_tools` are only ever wired into
  this new pipeline; `mllm.mcp_servers` (the old, doc-confirmed-wrong attempt) is
  removed entirely — never sent under any circumstances now, closing the dishonesty
  risk instead of leaving it as a "maybe it works anyway" field. The system prompt and
  `/start-agent` response are both explicit about which pipeline is active and what
  that means for tool support (`NOT_SUPPORTED` vs `"WIRED PER OFFICIAL DOCS — NOT YET
  LIVE-VERIFIED"`). `sanitize_payload` generalized to cover all four vendor blocks
  (`mllm`/`llm`/`asr`/`tts`) instead of just two, hardcoding nothing that isn't
  actually redacted. 5 new/updated regression tests assert the *actual outbound JSON*
  matches the documented schema (not just that the endpoint returns 200), including
  that `mllm.mcp_servers` is never sent regardless of pipeline choice. 62/62 backend
  tests pass. **Live verification (does Agora accept this payload; does the agent
  actually invoke a tool) intentionally not performed — it's a billed action requiring
  explicit go-ahead, tracked as the one remaining step in the P1 item above.**

- ✅ **Unowned action items now surfaced as a distinct alert, not silent "Unassigned"**
  (2026-08-31). Backend (`evidence.py`): added an `unowned` boolean per item in the
  handoff's `ownership` section, an `unowned_actions` count in `open_item_counts`, and
  a dedicated spoken-brief line for items that are unowned but *not yet* overdue
  (items that are both get folded into the existing overdue line's "owned by nobody"
  rather than announced twice — covered by a dedicated regression test). Frontend:
  `ActionItemsPanel` gives an unowned, non-complete item a distinct amber border and an
  "⚠ Unassigned" marker instead of the same neutral gray text every other owner gets; a
  *completed* item with no recorded owner deliberately does NOT get the warning (it's
  not an open accountability gap). `HandoffPanel` adds an "Unowned" count tile and
  flags unowned entries in the "Who owes what" list the same way. 4 new tests (2
  backend, 2 frontend) covering: the flag appears, the count is right, the
  unowned+overdue case isn't double-announced, and the completed-unowned case is
  correctly NOT flagged. 59/59 backend tests, 45/45 frontend tests, tsc clean, build
  succeeds, verified live against the real backend (`open_item_counts.unowned_actions`
  correctly `0` for the demo incident, whose one action item has an owner).

- ✅ **Enter-key submission confirmed working — not a bug** (2026-08-31). Retested in
  real Chrome (not the sandboxed pane) with a careful, isolated sequence: click the
  input, type, screenshot to confirm the text actually landed, *then* press Return.
  It worked cleanly both times — `handleCommandSubmit` fired, the "TOCSIN is
  processing…" indicator appeared, and a real reply came back
  ("FIELD OPERATOR: Second enter test" → "TOCSIN: Logged as REPORT (UNVERIFIED)...").
  The original "failure" was a race in the earlier test sequence (click immediately
  followed by type immediately followed by Return, with no verification in between) —
  not an app bug. No code change needed.
- 🔶 **Demo-incident reset investigated further — partially explained, correcting an
  earlier over-confident conclusion** (2026-08-31). First pass concluded "probably one
  of my own earlier `curl .../run-all` calls" and marked this resolved. That was
  premature: a later occurrence was checked more rigorously and the backend
  container's own access log had **zero HTTP requests logged for `/run-all` during its
  entire lifetime**, yet the demo incident was already back to its exact original seed
  conflict wording ("exhausted at 100%" / "normal and healthy (22% CPU)") the moment
  that container loaded it from Postgres at startup. Ruled out as causes: no frontend
  code path calls `run-all` except the explicit dashboard button (confirmed by reading
  every call site); no backend startup/lifespan code calls the handler function
  directly (confirmed by grepping the whole backend for its name — only test files
  reference it); the reminder background worker's routine `upsert()` explains a
  `updated_at` timestamp bump shortly after startup but does not explain the conflict
  *content* reverting to original wording, since that worker only ever appends
  reminders, never rewrites conflict records. **Genuine conclusion: if a reset
  happened, it happened during an earlier backend container's lifetime, and that
  container's logs no longer exist to check** (Docker Compose does not persist logs
  across a container recreate). Cannot be conclusively resolved with the evidence
  available now. Re-added to the open list below rather than left incorrectly closed.

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
