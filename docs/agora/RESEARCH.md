# Agora Integration — Research Notes

Status: documentation research only. No new runtime tests were executed as part of
this pass — findings below are (a) static comparisons of Tocsin's Agora-related code
against officially fetched Agora documentation, and (b) references to the local test
suite that already existed. This document does not claim production readiness and
does not modify any product code.

Sources consulted: `docs.agora.io` pages fetched directly (quoted/paraphrased below),
supplemented by Agora-domain search results where a direct fetch 404'd. Where a claim
below could not be confirmed against an official Agora page, it is labeled
`UNVERIFIED AGAINST OFFICIAL DOCS` rather than assumed correct or incorrect.

Files inspected in this repo:
- [backend/app/api/agora.py](../../backend/app/api/agora.py) — RTC token issuance, ConvoAI agent join/leave/status
- [backend/tests/test_agora_token.py](../../backend/tests/test_agora_token.py) — mocked unit tests for the above
- [backend/requirements.txt](../../backend/requirements.txt) — `agora-token-builder==1.0.0`
- [frontend/src/components/VoiceHUD.tsx](../../frontend/src/components/VoiceHUD.tsx) — Agora Web SDK client, stream-message handling
- [frontend/src/lib/agoraStreamDecoder.ts](../../frontend/src/lib/agoraStreamDecoder.ts) — hand-rolled transcript payload decoder
- `.env.example`, `backend/.env` (keys only, not values)

---

## 1. RTC token generation (`POST /api/agora/token`)

**Code**: builds tokens with `agora_token_builder.RtcTokenBuilder.buildTokenWithUid` /
`buildTokenWithAccount`, role constants `1` (publisher) and `2` (subscriber),
`expire_seconds` bounded `60`–`86400`.

**Documentation findings**:
- Agora's official token-generation reference (`docs.agora.io/en/realtime-media/rtc/build/authenticate-users/deploy-token-server`)
  confirms role constants **Publisher = 1**, **Subscriber = 2**, and that a token's
  hard validity ceiling is **24 hours** — the code's `le=86400` (24h) upper bound is
  consistent with this. **VERIFIED — MATCHES OFFICIAL DOCS.**
- Agora's officially-referenced source for token builders is the open-source GitHub
  repo `AgoraIO/Tools` (`DynamicKey/AgoraDynamicKey/...`), not a specific blessed PyPI
  package. The docs page fetched **did not name an official PyPI package**. The repo
  uses `agora-token-builder==1.0.0` from PyPI, which is a **third-party/community
  packaging** of that same reference algorithm, not something Agora's docs directly
  endorse by name. This has worked in the repo's own mocked tests (token starts with
  `006<app_id>`, which matches Agora's documented token version-prefix convention),
  but treat the PyPI package itself as **UNVERIFIED AGAINST OFFICIAL DOCS** (functionally
  plausible, not officially named).
- Channel name rules: official docs (Agora RTC SDK references, multiple platforms)
  state channel names must be **under 64 bytes** and may contain a broad set of
  letters, digits, spaces, and punctuation (`!#$%&()+-:;<=.>?@[]^_{}|~,`). Tocsin's
  `CHANNEL_NAME_REGEX = ^[a-zA-Z0-9_\-]{1,64}$` is a **strict subset** of what Agora
  allows — this is a deliberate local safety narrowing (good practice against
  header/URL injection), not a bug, and not something the docs require.

## 2. ConvoAI agent lifecycle (`/start-agent`, `/stop-agent`, `/local-agent-session`)

**Code** calls:
- `POST https://api.agora.io/api/conversational-ai-agent/v2/projects/{app_id}/join`
- `POST https://api.agora.io/api/conversational-ai-agent/v2/projects/{app_id}/agents/{agent_id}/leave`
- Basic Auth header built from `AGORA_CUSTOMER_ID` : `AGORA_CUSTOMER_SECRET` (base64).

**Documentation findings**:
- Fetching the official "Start a conversational AI agent" page
  (`docs.agora.io/en/conversational-ai/rest-api/agent/join` — note: the path is
  `.../rest-api/agent/join`, not `.../rest-api/join`, which 404'd) **confirms the
  exact URL, method, and Basic-Auth header scheme** used in the code, and confirms
  the RESTful auth pattern (Customer ID as username, Customer Secret as password,
  base64-joined) matches Agora's general RESTful authentication documentation.
  **VERIFIED — MATCHES OFFICIAL DOCS.**
- The "leave" endpoint path `/agents/{agentId}/leave` and its Basic-Auth header also
  match the officially fetched leave-endpoint documentation. **VERIFIED — MATCHES
  OFFICIAL DOCS.**
- Response shape: docs show `{ "agent_id": ..., "create_ts": ..., "status": "RUNNING" }`
  for join and an empty `{}` body for leave. The code reads `agent_id` (with fallbacks
  to `id` or a synthesized string) and treats any `200`/`201`/`204` as success — this is
  defensive but consistent with the documented shape.
- **Agent status endpoint — resolved (2026-08-31)**: this was previously
  `/api/agora/agent-status/{channel_name}`, backed only by the in-memory `ACTIVE_AGENTS`
  dict. Agora does publish a real "Query agent status" REST endpoint
  (`docs.agora.io/en/conversational-ai/rest-api/agent/query` — its existence is
  confirmed via search-result titles), but two separate `WebFetch` attempts against
  that page in this pass could not extract its exact URL path, headers, or response
  schema (the fetched content described monitoring concepts, not the REST contract).
  Per this project's "never invent an integration" rule, that endpoint was **not**
  implemented against a guessed contract. Instead the endpoint was renamed to
  `GET /api/agora/local-agent-session/{channel_name}` and its response now explicitly
  states `"source": "tocsin_local_in_memory_registry"`, `"live_agora_state_verified": false`,
  and a note that it reflects Tocsin's own bookkeeping, not a live Agora query. It is
  **not authoritative** — if the backend process restarts, or Agora's side terminates
  the agent server-side (idle timeout, error), the local registry can be stale or wrong.
  Implementing the real query call remains **NOT USED** (see capability matrix) until
  its official contract can be confirmed.

## 3. Gemini Live MLLM payload shape

**Code** sends, inside `properties.mllm`:
`enable`, `vendor: "gemini"`, `url` (a Gemini Live WebSocket URL the backend
constructs itself), `api_key`, `params` (`model`, `instructions`, `voice`,
`affective_dialog`, `proactive_audio`, `transcribe_agent`, `transcribe_user`,
`http_options.api_version`), `turn_detection` (`mode: "agora_vad"`, with
`interrupt_duration_ms`, `prefix_padding_ms`, `silence_duration_ms`, `threshold`),
`input_modalities`, `output_modalities`, `greeting_message`, `failure_message`.

**Documentation findings** (`docs.agora.io/en/conversational-ai/models/mllm/gemini`):
- `mllm.enable`, `vendor: "gemini"`, `api_key`, and a `params` object with `model`,
  `instructions`, `voice` (enum includes `Puck`, `Charon`, `Aoede`, `Fenrir`, `Kore`,
  `Leda`, `Orus`, `Zephyr` — matches the code's docstring list exactly),
  `affective_dialog`, `proactive_audio`, `transcribe_agent`, `transcribe_user`, and
  `http_options.api_version` are all **confirmed present in official docs**.
  **VERIFIED — MATCHES OFFICIAL DOCS.**
- `turn_detection.mode: "agora_vad"` **is a real, documented mode** (the other
  documented mode is `server_vad`), and its parameter set — `interrupt_duration_ms`,
  `prefix_padding_ms`, `silence_duration_ms`, `threshold` — matches the code's
  `agora_vad_config` block field-for-field. **VERIFIED — MATCHES OFFICIAL DOCS.**
- `input_modalities` / `output_modalities` accepting `["audio"]` (code default) is
  documented. **VERIFIED.**
- `model: "gemini-3.1-flash-live-preview"` (the code's default) **is the exact model
  name used in Agora's own Gemini MLLM documentation example** at the time of this
  fetch. **VERIFIED — MATCHES OFFICIAL DOCS** as of this research pass, but this is a
  `-preview` model name from Google, so it should be expected to change/rotate — do
  not treat this as a stable long-term default without periodically re-checking.
- The code builds its own `wss://generativelanguage.googleapis.com/ws/...BidiGenerateContent?key=...`
  URL and passes it as `mllm.url`. The fetched docs page's schema includes a `url`
  field in the `mllm` object family generally (Agora's schema lets you point MLLM
  vendors at a specific endpoint), but the exact requirement/necessity of hand-building
  this URL for the `gemini` vendor (versus Agora resolving it automatically from
  `vendor: "gemini"` + `api_key`) was **not directly confirmed** in the fetched excerpt.
  Labeled **UNVERIFIED AGAINST OFFICIAL DOCS** — plausible and harmless if redundant,
  but not something this pass could confirm is required versus optional.

## 4. MCP tool wiring — flagged discrepancy

**Code** places tool config at `properties.mllm.mcp_servers` (a list of
`{name, endpoint, transport: "sse"}`) plus `properties.advanced_features.enable_tools = true`,
specifically inside the `mllm` (Gemini Live) object.

**Documentation findings**:
- Agora's release notes (`docs.agora.io/en/conversational-ai/overview/release-notes`,
  fetched) describe the MCP feature as: *"A `llm.mcp_servers` field was added to the
  Start a conversational AI agent API to connect the LLM to an MCP server"* and
  *"Set `advanced_features.enable_tools` to `true` to enable tool calls."* This
  documents the field under **`llm.mcp_servers`** (the separate ASR/LLM/TTS pipeline),
  **not `mllm.mcp_servers`**.
- The dedicated Gemini Live MLLM documentation page
  (`docs.agora.io/en/conversational-ai/models/mllm/gemini`) — fetched directly — makes
  **no mention of tool calling, function calling, or `mcp_servers`** anywhere on the
  page.
- Agora's own docs also state plainly: *"Enabling MLLM automatically disables ASR,
  LLM, and TTS since the MLLM handles end-to-end voice processing directly."* Since
  `mcp_servers` is documented as a child of `llm`, and `llm` is disabled whenever
  `mllm.enable` is true, **it is not confirmed that `mllm.mcp_servers` is a real,
  functioning field at all** for the Gemini Live path Tocsin uses.

**Conclusion: `NOT CONFIRMED BY OFFICIAL DOCS — flagged for the user.`** This is the
single most important finding in this pass. It does not mean MCP tool-calling is
broken — Agora's docs may simply not have caught up with a newer `mllm.mcp_servers`
capability, or the field may be silently ignored by Agora's backend without erroring.
But right now there is no official documentation confirming that wiring MCP tools
under `mllm` (as opposed to the documented `llm`) does anything for a Gemini Live
agent. This can only be resolved with a live, credentialed `/start-agent` call against
real Agora + Gemini credentials while watching whether the agent actually invokes the
13 MCP tools listed in `DEFAULT_EMERGENCY_PROMPT` — that test was not run in this pass
and requires `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `AGORA_CUSTOMER_ID`,
`AGORA_CUSTOMER_SECRET`, `GEMINI_API_KEY`, and a reachable `MCP_SERVER_PUBLIC_URL`, all
of which are `IMPLEMENTED — CREDENTIAL REQUIRED` per the project README's existing
convention, not verified here.

## 5. Frontend Web SDK usage (`agora-rtc-sdk-ng@4.24.7`)

**Code**: `AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' })`,
`createMicrophoneAudioTrack`, and a `client.on('stream-message', ...)` listener that
feeds `decodeAgoraStreamMessage`.

**Documentation findings**:
- `stream-message` is a real, documented event on `IAgoraRTCClient` in Agora's Web SDK
  API reference (`api-ref.agora.io/en/video-sdk/web/4.x/interfaces/iagorartcclient.html`,
  confirmed present via search of Agora's own API-reference domain). Using it to
  receive ConvoAI transcript payloads is a legitimate, documented mechanism.
  **VERIFIED — MATCHES OFFICIAL DOCS (event exists and is used correctly).**
- The **exact payload wire format** `agoraStreamDecoder.ts` implements — pipe-delimited
  `messageId|seq|flags|base64Payload` framing, with base64-JSON and raw-JSON fallbacks —
  could **not be confirmed against an official Agora page** in this pass. The one
  official page fetched that discusses transcript delivery
  (`docs.agora.io/en/conversational-ai/develop/transcripts`) describes transcripts as
  delivered *"through Signaling channel messages"* using toolkit callbacks like
  `onTranscriptUpdated`, and explicitly states it does not document the raw wire
  format. Search results (not independently fetched/confirmed) describe transcript
  JSON fields as `turn_id`, `stream_id`, `message_id`, `user_id`, `text`, `words`,
  `final`/`turn_status` — these names do **not** exactly match what
  `agoraStreamDecoder.ts` looks for (it checks `object`, `role`, `speaker`, `sender`,
  `name` to determine the speaker, rather than `user_id`/`turn_id`).
  **Labeled UNVERIFIED AGAINST OFFICIAL DOCS.** The decoder was very likely written
  against observed real traffic (a defensible approach for a hackathon), and its
  multi-pattern fallback design suggests it was hardened empirically rather than from
  a single documented spec — but this repo currently has **no automated test**
  exercising `decodeAgoraStreamMessage` against a real or documented Agora payload
  sample, so its correctness is **UNVERIFIED**, not merely "credential required."
  Recommend capturing one real `stream-message` payload from a live, credentialed
  session and adding it as a fixture/unit test.

## 6. Env var / documentation gaps found in this repo (not Agora docs issues)

- **Resolved (2026-08-31)**: `.env.example` previously listed `AGORA_APP_ID` and
  `AGORA_APP_CERTIFICATE` but omitted `AGORA_CUSTOMER_ID`, `AGORA_CUSTOMER_SECRET`, and
  `MCP_SERVER_PUBLIC_URL` — all three are read via `os.getenv` in
  [agora.py](../../backend/app/api/agora.py) and are required for `/start-agent` to
  work (missing `AGORA_CUSTOMER_ID`/`SECRET` returns a `503`, per
  `test_start_agent_blocked_when_credentials_missing`). `.env.example` now documents
  all five Agora/MCP variables with inline comments explaining what each is for and
  which endpoints require them. Real secret values were not added or invented — the
  file still ships with empty values for the operator to fill in.

## 7. Actions taken on these findings (2026-08-31)

Following this research, the code and docs were updated to act on the findings above
without inventing anything unverified as verified:

- **`.env.example`** now documents `AGORA_CUSTOMER_ID`, `AGORA_CUSTOMER_SECRET`, and
  `MCP_SERVER_PUBLIC_URL` alongside the previously-documented `AGORA_APP_ID`/
  `AGORA_APP_CERTIFICATE`/`GEMINI_API_KEY`, with comments on which endpoints need them
  and the MCP-wiring caveat from §4. No real secret values were added.
- **`backend/app/api/agora.py`**: the system prompt sent to the live Gemini Live agent
  no longer asserts unconditional access to 13 MCP tools. The base prompt now instructs
  the model to only claim a tool result when a call actually returned one. A separate
  `MCP_TOOL_ROSTER_NOTICE` (still explicitly caveated as unverified) is appended only
  when an MCP server URL is actually configured for the session. The `/start-agent`
  response now returns an explicit `mcp_tool_calling_status` field labeling this
  MOCK/DEMO ONLY - UNVERIFIED whenever MCP is wired, instead of only a boolean
  `mcp_enabled` flag that implied it worked. The greeting message no longer claims
  "live tools" are active.
- **Agent status endpoint** renamed from `/api/agora/agent-status/{channel}` to
  `/api/agora/local-agent-session/{channel}` (see §2) with response fields that make
  clear it is local bookkeeping, not a live Agora query. Nothing in the frontend called
  the old path, so this is not a breaking change for this repo.
- **`frontend/src/lib/agoraStreamDecoder.ts`**: header comment now states plainly that
  its three frame patterns are empirical/observed, not confirmed by official Agora
  docs, and documents that unrecognized payloads must fail safe (return `null`).
  `frontend/src/components/VoiceHUD.tsx`'s stream-message handler already dropped
  null/empty decodes silently (pre-existing fail-safe behavior); a comment was added
  there to make that guarantee explicit rather than incidental.
- **`frontend/src/tests/transcript_hardening.test.ts`**: added a new fixture-test group
  (`1b. Unverified-format fail-safe tests`) covering: a well-formed but unrecognized
  JSON shape, random binary/non-UTF8 input, a JSON array root instead of an object, and
  a pipe-delimited frame whose base64 segment decodes to non-JSON text — all asserted
  to return `null` and never throw. One additional test documents (without claiming
  official confirmation) that the decoder's existing field fallbacks happen to also
  accept a `turn_id`/`stream_id`/`words[]` shape referenced in web-search summaries of
  Agora's transcript structure.
- **README.md**: capability matrix rows for the Agora agent, MCP tool calling, Slack,
  and PagerDuty/Jira/cloud tooling were rewritten so none of them imply live execution
  that hasn't been proven in this repository's test runs; a new "Honest Capability
  Status" section states plainly that this is a prototype, not a production-ready
  system. The stale "Payment Outage scenario" line in the test-suite description was
  corrected to "Identity Outage scenario" to match what `test_demo_scenario.py` and
  `backend/app/api/demo.py` actually implement.

None of the above required or used real Agora/Gemini credentials — every change is
either a documentation/labeling correction or a code change to what gets *sent* to
Agora's API and *claimed* to the model/operator, not a live call against Agora's
servers. The `mllm.mcp_servers` question in §4 is explicitly still open and can only be
closed with a live, credentialed session.

## 8. Test coverage status (existing, not re-run as new verification in this pass)

`backend/tests/test_agora_token.py` — per the repository's own README (`test_agora_token.py`
listed under the verified backend test suite) — covers token issuance (numeric Uid,
string account, invalid channel name) and `/start-agent`/`/stop-agent` with **fully
mocked** `httpx.AsyncClient` responses. This validates Tocsin's own request-building
and response-parsing logic, but by construction **cannot and does not verify** that
Agora's real API accepts the payload shape as-built (in particular, it cannot surface
the `mllm.mcp_servers` question in §4, since the mock always returns success
regardless of payload content).

---

## Capability matrix

Per the project's status-labeling convention (see `CLAUDE.md`), every row below is
assigned exactly one of: `VERIFIED IN CODE`, `OFFICIAL DOCS ONLY`, `CREDENTIAL REQUIRED`,
`UNVERIFIED`, `NOT USED`. `VERIFIED IN CODE` here means a successful, actually-run,
end-to-end request against the real Agora/Google endpoint was observed — nothing below
carries that status, because no live credentialed run was performed in this pass.

| Capability | Status | Note |
|---|---|---|
| RTC token generation (`/api/agora/token`) | `CREDENTIAL REQUIRED` | Code path and role/expiry constants match official docs; issuing a token that Agora's servers actually accept for a channel join has not been run live in this pass. Requires `AGORA_APP_ID` + `AGORA_APP_CERTIFICATE`. |
| ConvoAI agent join (`/api/agora/start-agent`) | `CREDENTIAL REQUIRED` | Request URL, auth scheme, and Gemini `mllm` payload fields match official docs (§1–3). Whether Agora's servers accept and run this exact payload has not been observed live. Requires `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `AGORA_CUSTOMER_ID`, `AGORA_CUSTOMER_SECRET`, `GEMINI_API_KEY`. |
| ConvoAI agent leave (`/api/agora/stop-agent`) | `CREDENTIAL REQUIRED` | URL and auth scheme match official docs. Not run live in this pass. |
| Local agent session lookup (`/api/agora/local-agent-session`) | `VERIFIED IN CODE` | This one only claims to be local bookkeeping (an in-memory dict read), which was exercised indirectly by the existing mocked `/start-agent` and `/stop-agent` tests that populate/clear `ACTIVE_AGENTS`. It makes no live Agora claim, so there is nothing further to verify. |
| Real Agora "Query agent status" REST endpoint | `NOT USED` | Its existence is referenced in Agora's own docs (search-result title only); its exact URL/schema could not be confirmed via `WebFetch` in this pass, and per project policy it was not implemented against a guessed contract. Not called anywhere in this codebase. |
| Gemini Live `mllm` params, voice enum, `agora_vad` turn detection | `OFFICIAL DOCS ONLY` | Confirmed to match `docs.agora.io/en/conversational-ai/models/mllm/gemini` field-for-field. Not run against a live Gemini Live session in this pass. |
| `mllm.mcp_servers` tool-calling wiring | `UNVERIFIED` | Official docs describe `llm.mcp_servers`, not `mllm.mcp_servers`; the Gemini Live doc page does not mention tool-calling at all. Now explicitly labeled MOCK/DEMO ONLY in the prompt, API response, and README. Only a live session can resolve this either way. |
| Emergency-intelligence MCP tool server (`mock-services/server.py`, 13 tools) | `CREDENTIAL REQUIRED` | The tool implementations themselves are real code calling real public APIs (USGS, NASA FIRMS, NOAA, OSM, Open-Meteo, GDACS, Copernicus CAMS) and a real/mock Slack path — this is independent of whether Agora ever invokes them via MCP. Live behavior for external-API-backed tools depends on those APIs; `notify_stakeholders` specifically requires `SLACK_WEBHOOK_URL` for live delivery. |
| Web SDK `stream-message` event subscription | `OFFICIAL DOCS ONLY` | The event itself is documented on Agora's Web SDK API reference. Confirmed present in code; not exercised against a live stream in this pass. |
| `agoraStreamDecoder.ts` wire-format parsing (pipe/base64/JSON patterns) | `UNVERIFIED` | No official Agora page confirms this exact wire format. Now covered by fixture tests (`transcript_hardening.test.ts`) proving deterministic, fail-safe (`null`) behavior on anything that doesn't match, but the format itself remains empirical. |
| Agora RTC channel-name policy (local regex) | `VERIFIED IN CODE` | Deliberately stricter than Agora's documented allowed character set; this is a local safety choice, not a claim about Agora's behavior, so it needed no live verification. |
| `agora-token-builder` (PyPI) as the token-generation implementation | `UNVERIFIED` | Functions correctly in this repo's own mocked tests; official docs name only the reference GitHub repo, not this specific PyPI package, as canonical. |
| Spoken audio summary broadcast into an active Agora channel | `CREDENTIAL REQUIRED` | Text synthesis exists and is tested locally; broadcasting into a live Agora channel requires an active credentialed room session, not exercised in this pass. |

---

## Summary table

| Area | Status |
|---|---|
| RTC token role constants (1/publisher, 2/subscriber) | VERIFIED — MATCHES OFFICIAL DOCS |
| RTC token 24h max expiry alignment | VERIFIED — MATCHES OFFICIAL DOCS |
| `agora-token-builder` PyPI package as "the" official tool | UNVERIFIED AGAINST OFFICIAL DOCS (docs name only the GitHub reference repo) |
| ConvoAI join/leave URLs + Basic Auth scheme | VERIFIED — MATCHES OFFICIAL DOCS |
| `/api/agora/local-agent-session` reflecting real Agora agent state | Renamed + relabeled as local-only (2026-08-31); real Agora query endpoint contract still unconfirmed |
| Gemini `mllm` params/voice enum/turn_detection (`agora_vad`) | VERIFIED — MATCHES OFFICIAL DOCS |
| `gemini-3.1-flash-live-preview` as current model name | VERIFIED as of this fetch (preview model — expect rotation) |
| Hand-built Gemini WS URL as `mllm.url` | UNVERIFIED — necessity vs redundancy not confirmed |
| `mllm.mcp_servers` for tool-calling on Gemini Live | **NOT CONFIRMED BY OFFICIAL DOCS** — docs describe `llm.mcp_servers` instead; code/prompt/README now label this MOCK/DEMO ONLY; requires live credentialed test to resolve |
| Web SDK `stream-message` event usage | VERIFIED — MATCHES OFFICIAL DOCS |
| `agoraStreamDecoder.ts` exact wire format | UNVERIFIED AGAINST OFFICIAL DOCS — now has fixture tests proving fail-safe (`null`) behavior on unrecognized payloads; wire format itself still unconfirmed |
| `.env.example` completeness for Agora vars | RESOLVED (2026-08-31) — `AGORA_CUSTOMER_ID`, `AGORA_CUSTOMER_SECRET`, `MCP_SERVER_PUBLIC_URL` now documented there |

No claim of production readiness is made anywhere above. Nothing in this document
should be read as confirming live behavior — every "VERIFIED" label here means
"matches official Agora documentation text," not "observed working against a live
Agora account." Live verification of §4 and §5 in particular requires real
`AGORA_CUSTOMER_ID`/`AGORA_CUSTOMER_SECRET`/`GEMINI_API_KEY` credentials and a running
voice session, which is outside the scope of this documentation-only research pass.
