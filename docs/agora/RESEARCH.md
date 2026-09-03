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
- **Agent status endpoint — implemented and live-verified (2026-09-03)**: the exact
  contract was provided by an EchoSphere mentor (Nitin) and independently confirmed
  against a direct `WebFetch` of `docs.agora.io/en/api-reference/api-ref/conversational-ai/query`:
  `GET /v2/projects/{appid}/agents/{agentId}` (same Basic Auth as join/leave) returns
  `{message, start_ts, stop_ts, status, name, agent_id}`, with `status` one of
  `IDLE | STARTING | RUNNING | STOPPING | STOPPED | FAILED`. This is now wired as
  `GET /api/agora/agent-status/{channel_name}` (resolves `agent_id` from the local
  `ACTIVE_AGENTS` registry, or accepts `?agent_id=` explicitly so a caller can check a
  specific agent even after a backend restart wiped the registry). **Live-verified
  end-to-end 2026-09-03**: started a real agent, queried this endpoint and got back
  Agora's real `"status": "RUNNING"`, stopped the agent, queried again and got back
  `"status": "STOPPED"` with a `stop_ts`. Upgraded to **`VERIFIED IN CODE`**.
  `GET /api/agora/local-agent-session/{channel_name}` (the local-registry-only lookup)
  is kept as a cheaper, non-network alternative and now points callers at the live
  endpoint in its own description instead of claiming to be the only option.
- **Account-wide agent listing — implemented and live-verified (2026-09-03)**: same
  mentor also pointed at `docs.agora.io/en/api-reference/api-ref/conversational-ai/list`
  (`GET /v2/projects/{appid}/agents`, filterable by `channel`/`state`/`from_time`/
  `to_time`/`limit`/`cursor`) as a way to find "zombie" agents left running from
  earlier test/dev sessions — each one keeps consuming managed-model minutes until
  explicitly stopped. Wired as `GET /api/agora/agents`, forwarding those filters.
  **Live-verified 2026-09-03**: returned a real (empty, as it happened) list of
  currently-running agents on this project's account. This endpoint was already used
  internally for the duplicate-agent guard in `/start-agent` (see
  `find_running_agents_in_channel`, live-verified 2026-09-02) — this is the same
  contract, now also exposed directly for manual zombie-hunting.

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

### UPDATE 2026-08-31 — now CONFIRMED NEGATIVE by official docs

A second research pass against the official Conversational AI release notes
(`docs.agora.io/en/conversational-ai/overview/release-notes`, fetched) resolved this
question. The release-note feature matrix states directly:

> `mcp_servers` is supported only under `llm`, not under `mllm` (introduced in v2.4
> for LLM integration).

Combined with Agora's separately-documented statement that enabling MLLM disables the
ASR/LLM/TTS pipeline, the conclusion is no longer ambiguous:

**`properties.mllm.mcp_servers` is not a supported field. Tocsin's MCP tools cannot be
invoked by the Gemini Live voice agent through the current wiring.** Status:
`UNVERIFIED` upgraded to **`NOT SUPPORTED — CONFIRMED BY OFFICIAL DOCS`**.

Consequences, all acted on in the code:

- The live voice prompt no longer tells the model it has 13 tools available. It is now
  instructed to only claim a tool result when a call actually returned one.
- `/start-agent` returns `mcp_tool_calling_status` labeling this MOCK/DEMO ONLY.
- README lists in-call MCP tool execution as `MOCK/DEMO ONLY`.

**The MCP tools themselves are not wasted work.** They are real code calling real
public APIs and remain callable directly and from `mock-services/server.py`. What is
not available is *the voice agent invoking them mid-call over Gemini Live*.

**Path to actually enabling in-call tools — now IMPLEMENTED (2026-08-31), NOT YET
LIVE-VERIFIED:** `backend/app/api/agora.py`'s `/start-agent` now accepts a
`voice_pipeline` field (`"gemini_live"` default, unchanged behavior; or
`"composed_tools"`, the new path). Building the `composed_tools` payload required
resolving a real contradiction found mid-implementation: the join-API reference lists
`llm.vendor` as `openai | azure | xai | custom` — Gemini is not in that enum — while a
separate, dedicated `docs.agora.io/en/conversational-ai/models/llm/gemini` page shows
Gemini used as a plain `llm` vendor via `style: "gemini"` with a raw URL and embedded
API key. Resolution: `vendor: "custom"` + `style: "gemini"`, matching both pages —
`"custom"` is the documented escape hatch for pointing the `llm` step at an arbitrary
endpoint, which is exactly what a raw Gemini URL is. This keeps Gemini as the
reasoning model; only the tool-calling *plumbing* changes, not the "brain".

ASR (`vendor: "deepgram"`) and TTS (`vendor: "minimax"`) both use
`credential_mode: "managed"` — confirmed via directly-fetched official examples for
each — so Agora supplies and bills those two hops itself; no new third-party API key
was added to this project. Full schema sources, all fetched directly this pass:
- ASR managed-credential example: `docs.agora.io/en/conversational-ai/models/asr/overview`
- LLM managed-credential example (confirms the `credential_mode` mechanism generally):
  `docs.agora.io/en/conversational-ai/models/llm/openai`
- Gemini as a plain `llm` vendor: `docs.agora.io/en/conversational-ai/models/llm/gemini`
- TTS managed-credential example: `docs.agora.io/en/conversational-ai/models/tts/overview`
  (via search-result excerpt, not a direct fetch — see caveat below)
- `mcp_servers` item shape + `advanced_features.enable_tools`:
  `docs.agora.io/en/api-reference/api-ref/conversational-ai/join`

**Caveat carried forward honestly:** the TTS managed-credential example came from a
web-search result excerpt quoting the docs page, not a direct `WebFetch` of that page
in this pass — slightly weaker sourcing than the others. The `asr.params` fields used
(`model: "nova-3"`, `language: "en"`) and `tts.params` fields (voice ID, sample rate)
are copied from the one confirmed example for each vendor; other valid values were not
enumerated, so these are "a working example," not "the only correct configuration."

**Managed-model menu confirmed (2026-09-03, mentor-provided)**: previously only one
example value per managed vendor had been confirmed. A mentor shared the actual menu
of models available under Agora-managed keys:
- Managed ASR: Agora's own built-in **ARES** engine, or **Deepgram** (`nova-2`,
  `nova-3` — this project uses `nova-3`)
- Managed LLM: **OpenAI** (`gpt-4o-mini`, `gpt-4.1-mini`, `gpt-5-nano`, `gpt-5-mini` —
  this project defaults to `gpt-4o-mini`)
- Managed TTS: **MiniMax** (`speech-2.6-turbo`, `speech-2.8-turbo` — this project uses
  `speech-2.8-turbo`), or **OpenAI** (`tts-1`) as a separate managed TTS vendor
This project's choices all fall within the confirmed menu. Not independently
re-verified against an official docs page in this pass — sourced from the mentor
screen-sharing the actual model list, not a `WebFetch`.

**composed_tools now defaults to managed OpenAI, not BYOK Gemini (2026-09-03)**: added
`composed_tools_llm_vendor` (`"openai"` default, `"gemini"` opt-in) so the
`composed_tools` pipeline can run with zero model keys of this project's own —
matching the EchoSphere organizers' stated preference for Agora-managed models when a
team has no provider keys of their own. **Live-verified 2026-09-03**: both the managed
OpenAI variant and the BYOK Gemini variant were each dispatched against the real
Agora ConvoAI API, both returned HTTP 200 with a real `agent_id` and Agora-reported
`"status": "RUNNING"`, and both were confirmed `"status": "STOPPED"` after cleanup via
the newly-wired `GET /api/agora/agent-status/{channel_name}` (see §2 update above).
Upgraded from `NOT YET LIVE-VERIFIED` to **`VERIFIED IN CODE`** for payload
acceptance and agent liveness on both vendor choices. Tool *invocation* through
either remains unverified (see the section immediately below).

**Transcript transport (RTM vs. stream-message) confirmed as either/or (2026-09-03,
mentor-provided)**: this project had implemented RTM end-to-end but never confirmed
whether RTM or the legacy stream-message data channel was the "correct" transport, or
whether the answer differed between `gemini_live` and `composed_tools`. Mentor's
answer: *"you can use either one, it's up to you — rtm or stream_message. make sure
you have set `enable_rtm` when starting the agent."* This matches what the code
already does (`advanced_features.enable_rtm: true` and
`parameters.data_channel: "rtm"` are both set on every agent join regardless of
pipeline). No code change required; this raises confidence in the existing RTM wiring
but does not by itself confirm that a transcript message has ever actually arrived
from a real speaking agent — that observation is still outstanding (see §9).

### UPDATE 2026-09-03 — mentor gave a conflicting, unconfirmed claim; not acted on

Asked an EchoSphere mentor (Nitin) directly whether `mllm` (Gemini Live) would ever
get MCP tool support. His answer: *"I think mllm does support MCP the same way as
llm. I'll check this."* That is the opposite of this document's own finding two
sections up, which is based on a directly-fetched official release-notes page stating
`mcp_servers` is supported only under `llm`, not `mllm`.

Recorded here rather than silently believed or silently ignored, per this project's
"organize evidence without inventing certainty" rule: a mentor's off-the-cuff
recollection is real evidence, but it is *weaker* sourcing than a directly-fetched,
quoted official docs page, and it was explicitly hedged ("I think", "I'll check") by
the person who said it. **No code changed on the basis of this claim.** The `NOT
SUPPORTED — CONFIRMED BY OFFICIAL DOCS` status two sections up stands until either
the mentor follows up with something more definite, or a fresh docs fetch/live test
resolves the conflict one way or the other. If this matters for the demo, re-check
`docs.agora.io/en/conversational-ai/overview/release-notes` for a newer entry before
trusting either source over the other.

**This trades Gemini Live's single native-audio hop for three hops (ASR → LLM → TTS),
a real latency cost** — chosen only when the caller explicitly requests
`composed_tools`, never as a silent default. `mcp_tool_calling_status` in the
`/start-agent` response is explicit either way: `NOT_SUPPORTED` for `gemini_live`
(even if an MCP URL is configured — it is never sent), or `"WIRED PER OFFICIAL
DOCS — NOT YET LIVE-VERIFIED"` for `composed_tools`. Regression tests
(`test_agora_token.py`) assert the actual outbound JSON payload matches this
documented shape and that `mllm.mcp_servers` is never sent regardless of pipeline
choice.

### UPDATE 2026-09-03 — root cause of "lists tools, never calls one" found and fixed; live-verified

Installed the official Agora Skills package (`npx skills add AgoraIO/skills`, per a
mentor's direct recommendation in the EchoSphere Q&A) and consulted its bundled
references rather than guessing. `references/conversational-ai/server-mcp.md`
mentioned Agora's own official reference MCP server uses "MCP Streamable HTTP
protocol" — not SSE. This project's `mcp_servers` payload was sending
`"transport": "sse"` against an endpoint suffixed `/sse`, both undocumented.

Confirmed directly against a fetch of
`docs-md.agora.io/en/conversational-ai/rest-api/agent/join.md`: the `transport`
field under `llm.mcp_servers` **only documents one valid value,
`"streamable_http"`** — quoting the docs: *"transport (string, optional, possible
values: streamable_http): Transport protocol type."* `"sse"` was never a
documented value; Agora's join API simply accepted it without validation error,
which is exactly why payload acceptance was never proof of correctness.

Fixed both sides of the connection together (they have to agree):
- `mock-services/server.py`: `mcp.run(transport="sse", ...)` → `mcp.run(transport="http", ...)`
  (FastMCP's Streamable HTTP transport; confirmed via the installed `fastmcp==3.4.7`
  source that this serves at path `/mcp` by default, not `/sse`).
- `backend/app/api/agora.py`: `mcp_servers[0].transport` → `"streamable_http"`,
  endpoint suffix `/sse` → `/mcp`.

**Live-verified end-to-end 2026-09-03** — the first genuine tool *invocation* this
project has ever observed, not just discovery: started a real `composed_tools`
agent against the corrected config (via a public ngrok tunnel to the rebuilt
mock-services container), confirmed the Streamable HTTP handshake succeeded from
Agora's real infrastructure (`POST /mcp` 200, `POST /mcp` 202, `GET /mcp` 200 —
the session-open sequence), confirmed `ListToolsRequest` succeeded (as always),
then used `POST /api/agora/agent-think` to inject an unambiguous tool-triggering
instruction ("check current earthquake activity near San Francisco using your
earthquake monitoring tool"). Mock-services' log then showed, for the first time
ever, `Processing request of type CallToolRequest`, immediately followed by a real
outbound call to `earthquake.usgs.gov`'s live API returning `HTTP 200 OK`. Cleaned
up: agent confirmed `STOPPED` via the new agent-status endpoint, ngrok tunnel torn
down.

Upgraded from `CREDENTIAL REQUIRED` to **`VERIFIED IN CODE`**: both Agora's
acceptance of the corrected payload and the agent's actual tool invocation are now
directly observed, not inferred. This also incidentally live-verified
`POST /api/agora/agent-think` (TODO.md item 9) for the first time, since it was the
mechanism used to trigger the test.

### Other findings from the 2026-08-31 release-notes pass

Current latest version: **v2.11 (2026-08-11)**. Relevant capabilities Tocsin does not
yet use, all `OFFICIAL DOCS ONLY` (documented, not exercised here):

| Capability | Version | Relevance to Tocsin |
|---|---|---|
| Transcripts delivered as **RTM messages** | v2.9 | **Implemented 2026-08-31, see §9.** Tocsin now reads transcripts from RTM channel messages as the primary transport; the old RTC `stream-message` listener is kept only as an inert fallback. |
| "Send a custom instruction" (`/think`) | v2.6 | Would let Tocsin push evidence-record context into the live agent mid-conversation. |
| "Broadcast a message using TTS" (`/speak`) | — | **Implemented 2026-08-31, see §10.** Directly closes problem-statement item 11. |
| Paginated conversation-turn / history API | v2.5, v2.7 | A server-side transcript source that does not depend on the empirical client decoder. |
| Agent state callbacks (listening/thinking/speaking) | v2.6, v2.9 | Honest UI state instead of inferred activity. |
| `opt_out` session data retention control | v2.8 | Relevant to the privacy/consent obligations noted in the project brief. |
| Avatars, filler phrases, presets | v2.5–v2.10 | Deliberately **NOT USED** — cosmetic for an incident-response tool. |

Original pre-update analysis is preserved below for provenance.

**Superseded conclusion (2026-08-30):** at that time this was recorded as
`NOT CONFIRMED BY OFFICIAL DOCS` with the note that Agora's docs might simply not have
caught up. The release-note matrix has since settled it in the negative.

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

## 9. RTM transcript migration — now IMPLEMENTED (2026-08-31)

Per `docs.agora.io/en/conversational-ai/develop/transcripts`, live transcript data
from the ConvoAI agent is delivered as **Agora Signaling (RTM) channel messages**,
not RTC events: "Transcript data is delivered through Signaling channel messages."
The toolkit reference requires a distinct RTM connection alongside RTC
(`ConversationalAIAPI.init({ rtcEngine, rtmEngine, renderMode })`), subscribes via
`subscribeMessage(channel_name)`, and requires the agent-join call to set
`advanced_features.enable_rtm: true` and `parameters.data_channel: "rtm"` — both now
confirmed **mandatory** for RTM delivery, not optional flags.

**What was actually implemented, and why it stops short of vendoring Agora's toolkit:**
Agora's own reference implementation
([`Conversational-AI-Demo`](https://github.com/AgoraIO-Community/Conversational-AI-Demo/tree/main/Web/Scenes/VoiceAgent/src/conversational-ai-api))
is not published as an npm package — the docs say to copy its source into your
project. Reading that source directly (`index.ts`, `type.ts`, ~2,700 lines
combined) revealed it depends on `@agora-js/report` (an internal Agora telemetry
package) and on a demo-app-specific file (`@/lib/latency-metrics`) that is not
part of the toolkit itself — meaning it is not cleanly vendorable as a
self-contained unit. Critically, reading `index.ts`'s `_handleRtmMessage` method
confirmed the actual wire format: RTM channel messages are **plain JSON** (string
or UTF-8 bytes, `JSON.parse`'d directly — no chunking or base64 envelope), with an
`object` field of `"user.transcription"` / `"assistant.transcription"` and a
`text`/`final`/`turn_id` shape (see `type.ts`'s `IUserTranscription`/
`IAgentTranscription`). That is exactly the shape `agoraStreamDecoder.ts`'s
"Pattern 3: Direct JSON string" branch already parses.

Given that, Tocsin implements its own RTM **transport** (not the whole toolkit) in
`frontend/src/lib/agoraRtmTranscripts.ts`, using the real `agora-rtm` npm package
(v2.3.0, confirmed public) directly, and reuses the existing
`decodeAgoraStreamMessage` as the parser. This is a smaller, fully-understood
surface — one new dependency, no internal Agora packages — at the cost of not
having the toolkit's word-level partial-transcript smoothing
(`sub-render.ts`), which is a UX nicety, not a correctness requirement.

Changes made:
- **Backend** (`backend/app/api/agora.py`): new `POST /api/agora/rtm-token`
  endpoint using `agora_token_builder.RtmTokenBuilder` (already present in the
  installed `agora-token-builder` PyPI package — no new Python dependency).
  `advanced_features.enable_rtm: true` and `parameters.data_channel: "rtm"` are now
  sent on every `/start-agent` call, for both `gemini_live` and `composed_tools`
  pipelines — this is the transport, not a pipeline-specific feature.
- **Frontend**: `agora-rtm@2.3.0` added as a dependency. Both `VoiceHUD.tsx` (used
  on `/`) and `voice-test/page.tsx`'s independent inline Agora client (used on
  `/voice-test` — these are two separate implementations, not shared code) now
  fetch an RTM token after RTC join and start an RTM session via
  `startRtmTranscriptSession`. The old RTC `stream-message` listener is kept in
  both files as an inert fallback, in case Agora ever delivers over that channel
  again; it is expected to receive nothing once `data_channel: "rtm"` is honored
  server-side.
- **Why both frontend paths needed the change**: `/voice-test` does not import or
  use `VoiceHUD.tsx` — it has its own ~2,300-line inline Agora RTC implementation.
  Setting `data_channel: "rtm"` in the shared backend endpoint affects agents
  started from *either* page, so both needed the RTM listener or `/voice-test`'s
  "AI Agent" transcript lines would have silently stopped appearing.

**What was verified without a live paid agent session:**
- `POST /api/agora/rtm-token` issues a real token against real
  `AGORA_APP_ID`/`AGORA_APP_CERTIFICATE` credentials (curl-verified, HTTP 200 with
  a well-formed token).
- Backend regression tests confirm `enable_rtm`/`data_channel` are present on every
  `/start-agent` payload sent to Agora (mocked transport, real payload assertions).
- Frontend build and full test suite pass with the new code paths.
- In a real browser (sandboxed Chrome pane, real Agora RTC/RTM servers, no mic
  permission available in that sandbox): RTC join succeeded against the live Agora
  gateway (`Joining channel success: channel: inc-demo-identity-outage, uid: 9971`),
  the RTM token request returned HTTP 200, and RTM login/subscribe (sequenced
  immediately after RTC join, before microphone capture) produced no console
  errors before the sandbox's expected `PERMISSION_DENIED` on `getUserMedia`.

**What is NOT verified, and cannot be without a live paid session:** whether a real
ConvoAI agent, once actually speaking, delivers a transcript message in the exact
shape assumed above. `EMessageType`/`IUserTranscription`/`IAgentTranscription` come
from reading Agora's own source, not from running it — treat this as
`CREDENTIAL REQUIRED`, not `VERIFIED IN CODE`, until a live session with an active
agent confirms a transcript actually renders.

### UPDATE 2026-09-04 — now live-tested exhaustively; still zero transcript messages ever observed

Ran the exact live session this section says was needed. Correction to the record
below, then the actual finding.

**Correction:** this section's "reference implementation" research pointed at
`AgoraIO-Community/Conversational-AI-Demo`, a demo app whose toolkit source has to be
copied in by hand. That was incomplete — Agora also publishes a proper installable
package, `agora-agent-client-toolkit` (npm) /
[`agent-client-toolkit-ts`](https://github.com/AgoraIO-Conversational-AI/agent-client-toolkit-ts)
(source), which this project does not use (it reuses the RTM login/subscribe +
`decodeAgoraStreamMessage` approach built from reading the demo app instead). Reading
the *published* toolkit's own source turned up something this project's approach had
wrong: its `subscribeMessage()` never calls `rtmEngine.subscribe(channel)` — it only
registers an `RTMEventType.MESSAGE` listener after login — and its own `init()`
example comments that the RTM login identity "must match the RTM token subject;
often `String(rtcUid)`". This project's RTM login identity was
`` `tocsin-voicetest-${uid}` ``, not the bare uid. `agora-rtm`'s own `ChannelType`
enum (`'MESSAGE' | 'STREAM' | 'USER'`, confirmed in the installed `agora-rtm@2.3.0`
type definitions) confirms `'USER'` is a private/peer-to-peer channel type distinct
from the `'MESSAGE'` type this project subscribes to — consistent with transcripts
arriving as messages addressed to the participant's own RTC uid rather than as a
channel-wide broadcast. **Fixed**: `frontend/src/app/voice-test/page.tsx`'s RTM login
now uses `String(uid)` (the same numeric id passed to `client.join()`), not a
prefixed label.

**The finding, after fixing that and testing exhaustively:** it did not close the gap.
Real Chrome, real microphone, real Agora account, both pipelines, the corrected RTM
identity, `agent-think`, and `/speak` (which forces guaranteed verbatim playback,
unlike `agent-think`) were all exercised in the same live session. Audio was
independently confirmed genuine on **multiple separate occasions** two different
ways: tapping the actual Web Audio `AnalyserNode` already wired to the agent's RTC
track (clean attack/decay envelopes, not noise) and, separately, Agora's own RTC SDK
emitting real `AUDIO_OUTPUT_LEVEL_TOO_LOW` / `..._RECOVER` exception events for
uid 9999 at the exact moments speech was triggered. RTM login and channel subscribe
both completed successfully every time (confirmed by bypassing a console-log capture
tool that turned out to have its own dedup quirk — direct in-page interception of
`console.log` was used instead once that quirk was found, to remove all doubt).
**Across all of it, zero `assistant.transcription` (or any) RTM messages were ever
received, and the legacy RTC `stream-message` fallback also received nothing.**

Conclusion: transcript delivery over RTM/Signaling for this project's Conversational
AI agents has never been observed working, on any pipeline, under any RTM identity
tried, despite the join payload matching every documented requirement
(`advanced_features.enable_rtm: true`, `parameters.data_channel: "rtm"`) and the RTM
connection itself working perfectly. This is now the single most load-bearing
unresolved item in the whole integration — it is why the voice room's "Live
Conversation" panel never shows the agent's spoken replies, and why nothing the agent
*says* (as opposed to what the operator says, which reaches evidence independently via
the browser's own `SpeechRecognition`, unrelated to RTM) ever becomes a structured
observation. Given docs.agora.io's own transcripts page admits it does not document
the wire format, and the published toolkit's source only confirms *how a client should
listen*, not *what makes the agent actually publish* — this looks like it needs an
answer from Agora directly (mentor channel or support), with this section handed over
as the precise, already-isolated repro: RTM connects, subscribes, agent audibly
speaks, nothing arrives.

## 10. Spoken audio summary broadcast — now IMPLEMENTED (2026-08-31)

Official schema (`docs.agora.io/en/api-reference/api-ref/conversational-ai/speak`,
fetched directly this pass after earlier attempts returned only an index/nav page —
the working URL pattern is the `.md` suffix: `.../conversational-ai/speak.md`):

```
POST /v2/projects/{appid}/agents/{agentId}/speak
Body: { "text": string (required, max 512 bytes),
        "priority": "INTERRUPT" | "APPEND" | "IGNORE" (optional, default INTERRUPT),
        "interruptable": boolean (optional, default true) }
Auth: Basic, same customer_id:customer_secret scheme as /join and /leave.
```

Implemented as `POST /api/agora/speak` (`backend/app/api/agora.py`): looks up the
agent_id already tracked in `ACTIVE_AGENTS` for the requested channel (returns 404,
not a silent no-op, if none is running — this endpoint speaks through an existing
agent session, it does not start one), then calls Agora's endpoint with the exact
documented field names. Wired into `HandoffPanel.tsx`'s new "🔊 Broadcast" button,
which sends the same `spoken_brief` text already generated by
`GET /api/incidents/{id}/handoff` — the written and spoken forms of a handoff
still cannot drift apart, and now the spoken form can actually reach the room, not
just be copy-pasted.

Verified: 2 new regression tests assert the outbound URL and JSON body match the
documented schema exactly, and that a channel with no tracked agent returns 404 —
curl-verified against the real running backend and real Agora credentials (correct
404 for a channel with no active agent).

### UPDATE 2026-09-03 — audio delivery live-verified, real Chrome + real mic

The one thing this section had flagged as unverified since 2026-08-31: whether
Agora's real `/speak` endpoint accepts the call *and* audio is actually heard, not
just accepted. Real Chrome connected with real microphone access this session
(the first time this pass had it), so this was finally testable end to end.

Started a real `gemini_live` agent in the demo channel, confirmed `RUNNING` via
`GET /api/agora/agent-status/{channel}`, then called `POST /api/agora/speak` with
a distinctive test sentence. Agora returned HTTP 200, `"status": "spoken"` — but
payload acceptance alone was already known to be an unreliable signal of real
behavior (see §4's transport bug), so acceptance was not treated as proof.

Verified further: the `/voice-test` page already wires the agent's real RTC audio
track to a Web Audio `AnalyserNode` for its "AI speaking" visual indicator
(`aiAnalyser.fftSize = 1024`, `frontend/src/app/voice-test/page.tsx`). Temporarily
tapped that analyser via a console-injected `AudioContext.prototype.createAnalyser`
monkey-patch (debugging instrumentation only, not a source change) and polled it
through the broadcast window. Result: silent for ~3.9 seconds (network + TTS
synthesis latency), then a real speech envelope —
`max: 0 → 177 → 181 → 159 → 137 → 126 → 105` across the frequency spectrum, a clean
attack/peak/decay shape distinguishing genuine audio from noise or a false
positive. Cleaned up: agent confirmed `STOPPED` via the same live status endpoint,
zero agents left running on the account afterward (`GET /api/agora/agents` count 0).

**Upgraded from `NOT YET LIVE-VERIFIED` to `VERIFIED IN CODE`** — this is the first
confirmed instance of Tocsin's spoken-summary path actually producing audible
output in a real channel, not merely an accepted API call.

---

## 11. Live credentialed test (2026-08-31) — real bug found and fixed

A real, billed `POST /api/agora/start-agent` call with `voice_pipeline:
"composed_tools"` (and MCP wiring active) was made against a real running channel,
with a real browser (`/voice-test`) joined via RTC+RTM. This is the first live
credentialed test of the composed_tools pipeline; everything above this section
was schema-verified against docs and mocked tests only.

**Real bug found**: Agora's actual join API rejected the first attempt with
`HTTP 400: "Invalid value at properties.asr.params.url: required field is
missing"`, then the same for `properties.tts.params.url` once asr was fixed. The
managed-credential examples in `docs.agora.io/en/conversational-ai/models/asr/overview`
and the MiniMax TTS page both do require an explicit `params.url` even under
`credential_mode: "managed"` — that field only means Agora supplies the *API key*,
not the endpoint. This codebase's payload had omitted `url` entirely for both
blocks. **Fixed** in `backend/app/api/agora.py`:
`asr.params.url = "wss://api.deepgram.com/v1/listen"`,
`tts.params.url = "wss://api.minimax.io/ws/v1/t2a_v2"` (both confirmed exact
literal values from the respective docs pages). Regression tests added in
`backend/tests/test_agora_token.py` assert these exact URLs.

**After the fix**: the same call was accepted — Agora returned a real `agent_id`,
`mcp_enabled: true` was echoed back, and in the live browser the agent's RTC audio
track was subscribed and played (`RemoteAudioTrack.play onSuccess` in the SDK's
own console log) — real audio genuinely flowed from the ConvoAI agent into the
room. This **upgrades item 6's first half** — Agora accepting the
`llm.mcp_servers` + `advanced_features.enable_tools` payload — from "not yet
observed" to confirmed; whether the agent actually *invoked* a tool through it
was not observed in this pass (nothing in the test window required a tool call).

**Not confirmed in this pass**: no transcript text appeared in the RTM-driven
transcript panel during the ~30s test window, despite RTM login+subscribe both
succeeding (200 OK from `/api/agora/rtm-token`, confirmed via network inspection).
This could mean the agent's greeting message doesn't fire automatically, RTM
delivery genuinely isn't working, or the window was too short — not
distinguished in this pass. `voice-test/page.tsx`'s `addLog` now also mirrors to
`console.log` (previously only fed an unrendered `logs` state) specifically to
make the next live attempt diagnosable from the browser console instead of
requiring React-state inspection through the DOM. The agent was stopped
(`/stop-agent`, confirmed `"status": "stopped"`) once this was established, to
control cost — `/speak` (item 4) was not tested in this pass; it needs a fresh
live agent session.

Test environment note: the real Chrome extension (`mcp__claude-in-chrome`) was
not reachable this pass, so the sandboxed Browser pane was used instead, which
blocks real microphone capture. `navigator.mediaDevices.getUserMedia` was
monkey-patched with a synthetic silent oscillator stream purely so the RTC/RTM
join flow could complete without real hardware — this is a test-environment
workaround only, not a code change, and explains why VAD showed 0% speech
confidence throughout (no real speech was ever produced for the agent to
transcribe).

---

## 12. Live credentialed test with a real microphone (2026-09-01) — root cause of the day's failures found

Continuation of §11, this time with real Chrome and a real microphone (the earlier
pass's synthetic audio workaround wasn't needed). Two real bugs found and fixed:

**Bug 1 — wrong Gemini model for composed_tools, confirmed via direct curl against
the live Gemini API (not guessed):**

```
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-live-preview:streamGenerateContent?alt=sse&key=..."
→ HTTP 400: "models/gemini-3.1-flash-live-preview only supports real-time
   bidirectional streaming via WebSocket (bidiGenerateContent). Please use the
   Gemini Live API (bidiGenerateContent via WebSocket) instead of generateContent."
```

`StartAgentRequest.model` (default `gemini-3.1-flash-live-preview`) was being reused
for *both* pipelines, but `composed_tools`'s `llm` block calls the plain REST
`streamGenerateContent` endpoint, which that model cannot serve. This is the actual
root cause of "Sorry, I encountered an issue" appearing on every single turn
throughout the day's earlier testing (§11's model-quota theory was a red herring —
the real quota exhaustion was on `gemini-3.7-flash`, used only by this project's own
extraction pipeline, an entirely separate code path from the agent's own LLM call).
Fixed with a new `composed_tools_llm_model` field, default `gemini-3.6-flash`
(confirmed working via the same curl methodology). `backend/app/api/agora.py`'s two
pipelines now have fully independent model fields instead of sharing one with
incompatible requirements.

**Bug 2 — RTM dependency silently missing from the Docker image**, discovered while
debugging why RTM never produced a single console log line all day: `grep -rl
'agora-rtm' /app/.next/static/chunks/` returned nothing even after adding the
package to `package.json`, because Next.js's webpack minifier strips literal
package-name strings from production chunk output — a red herring that cost real
debugging time. The actual chunk mapping (`"lib/agoraRtmTranscripts.ts -> agora-rtm"`)
was confirmed present in `.next/react-loadable-manifest.json`, and a one-off
container built from the `deps` Docker stage confirmed `agora-rtm@2.3.0` genuinely
installs. The dependency was never actually the problem; the real gap was that
`client.login()`/`client.subscribe()` have no documented timeout, so if the RTM WSS
handshake were silently blocked, it would hang forever with zero log output --
indistinguishable from "still connecting." Added explicit step-by-step logging and
a 10s timeout per call in `agoraRtmTranscripts.ts`.

**After both fixes**: a real live conversation happened. The agent held a
back-and-forth exchange with a real human voice, and its own response ("Logged as
UNCLASSIFIED (UNVERIFIED). Extracted via keyword fallback (LLM unavailable) — treat
as UNVERIFIED.") — phrasing that reflects `DEFAULT_EMERGENCY_PROMPT`'s evidence-
labeling instructions — appeared in the transcript panel correctly labeled
**TOCSIN**, not Field Operator. This is the first confirmed instance all day of a
genuinely agent-sourced, correctly-attributed transcript entry.

**Also found**: two unrelated real bugs in `voice-test/page.tsx`, both fixed
alongside the above (see the `fix: real bugs found via live voice testing` commit):
`.vcc-root`'s `min-height: 100vh` + `overflow: visible` let every nested scroll
panel grow the whole page instead of scrolling internally (fixed to `height: 100vh`
+ `overflow: hidden`); and Chrome's local `SpeechRecognition` fallback path
mislabeled agent speech leaking through the mic as the operator's own words, because
its finalization lag (1-3s) meant checking "is the agent currently speaking" at
result-time missed speech that had already ended (fixed with a 3s post-speech
cooldown window).

**Still open**: whether the agent invokes an MCP tool through a real conversational
turn (only discovery — `ListToolsRequest` — was observed in `mock-services` logs,
not an actual tool call), and whether `/speak` audibly broadcasts into a live room.

---

## 13. Mid-session agent updates — `update` and `think` endpoints (researched 2026-09-01, not yet implemented)

Surfaced by Agora DevRel's own community resource links (session recap shared in a
WhatsApp group), which pointed to `recipes.agora.io`'s "Dynamic Tool Sets" and
"Dynamic Instructions" recipe categories. Confirmed against official docs via the
same `.md`-suffix direct-fetch pattern used for `/speak` in §10 (the plain URL
without `.md` only ever returns an overview/index page for these two endpoints,
not the actual schema — worth remembering for future Agora doc lookups).

**`POST /v2/projects/{appid}/agents/{agentId}/update`** — updates a *running*
agent's persistent configuration going forward, without restarting it:

```json
{
  "properties": {
    "token": "string",
    "llm": {
      "system_messages": [{"role": "string", "content": "string"}],
      "params": {"model": "string", "max_token": "integer"}
    },
    "mllm": {"params": "object"}
  }
}
```
Response 200: `{"agent_id", "create_ts", "status"}`. Both `llm` (composed_tools
pipeline) and `mllm` (gemini_live pipeline) blocks are supported, so this endpoint
works for either of Tocsin's two pipelines. Overwrites the config set at join time
for whichever field is sent — not documented whether omitted fields are preserved
or cleared, so a real call is needed to confirm before relying on partial updates.

**`POST /v2/projects/{appid}/agents/{agentId}/think`** — injects a *one-off*
instruction into the live conversation pipeline as if it were user input; the
agent processes and responds to it immediately, live in the running session:

```json
{
  "text": "string (required)",
  "on_listening_action": "inject|interrupt|ignore",
  "on_thinking_action": "interrupt|ignore",
  "on_speaking_action": "interrupt|ignore",
  "interruptable": "boolean",
  "metadata": "object"
}
```
Response 200: `{"agent_id", "channel", "start_ts"}`.

**Why this matters for Tocsin**: `/update` could keep a live agent's system
prompt in sync as incident evidence changes (new conflict, severity escalation)
instead of only reflecting what was true at agent-dispatch time. `/think` is the
more distinctive one — it could let the backend push a real-time development
into the live voice conversation and have the agent proactively announce it
("a new conflict was just detected...") without the human asking first, which
maps more directly onto "AI incident commander" than passive Q&A. Status:
`OFFICIAL DOCS ONLY` — schema confirmed via direct fetch, neither endpoint has
been called against a real agent yet. Not yet wired into `backend/app/api/agora.py`.

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
| ConvoAI agent join (`/api/agora/start-agent`), `composed_tools` pipeline | `VERIFIED IN CODE` | **Live-verified 2026-08-31** (see §11): real Agora acceptance, real `agent_id` returned, real RTC audio from the agent played in a live browser. Found and fixed a real bug in this pass (`asr`/`tts` blocks were missing required `params.url`). The `gemini_live` pipeline itself was not re-tested this pass (only `composed_tools` was live-dispatched) — its schema is unchanged from earlier verification. |
| ConvoAI agent leave (`/api/agora/stop-agent`) | `VERIFIED IN CODE` | **Live-verified 2026-08-31**: stopped the real agent started in §11, confirmed `"status": "stopped"`. |
| Local agent session lookup (`/api/agora/local-agent-session`) | `VERIFIED IN CODE` | This one only claims to be local bookkeeping (an in-memory dict read), which was exercised indirectly by the existing mocked `/start-agent` and `/stop-agent` tests that populate/clear `ACTIVE_AGENTS`. It makes no live Agora claim, so there is nothing further to verify. |
| Real Agora "Query agent status" REST endpoint (`/api/agora/agent-status/{channel_name}`) | `VERIFIED IN CODE` | **Fully wired and live-verified 2026-09-03** (see §2 update): started a real agent, queried this endpoint and got Agora's real `"status": "RUNNING"`, stopped it, queried again and got `"status": "STOPPED"` with a `stop_ts`. Contract provided by an EchoSphere mentor and cross-checked against a direct fetch of the official docs page. |
| Account-wide agent listing (`/api/agora/agents`) | `VERIFIED IN CODE` | **Live-verified 2026-09-03**: returned a real (empty) list of currently-running agents for this project's Agora account. For finding zombie agents left running from earlier sessions. |
| Gemini Live `mllm` params, voice enum, `agora_vad` turn detection | `OFFICIAL DOCS ONLY` | Confirmed to match `docs.agora.io/en/conversational-ai/models/mllm/gemini` field-for-field. Not run against a live Gemini Live session in this pass. |
| `mllm.mcp_servers` under `gemini_live` pipeline | `NOT USED` (confirmed unsupported) | **Resolved 2026-08-31**: never sent regardless of request — official docs confirm `mcp_servers` belongs under `llm`, not `mllm`. |
| `llm.mcp_servers` under new `composed_tools` pipeline | `VERIFIED IN CODE` | **Root cause of "discovery only, no invocation" found and fixed 2026-09-03**: transport was `"sse"` (undocumented) against a `/sse` endpoint; official docs only document `"streamable_http"`. Fixed on both sides (this project's MCP server + the join payload) and live-verified: Agora's real infra completed the Streamable HTTP handshake, `ListToolsRequest` succeeded, and — for the first time — a `CallToolRequest` fired and the invoked tool made a real call to USGS's live earthquake API. |
| `composed_tools` on Agora-managed OpenAI (`composed_tools_llm_vendor="openai"`, default) | `VERIFIED IN CODE` | **Live-verified 2026-09-03**: real Agora acceptance, real `agent_id`, `"status": "RUNNING"` confirmed via the new agent-status endpoint, then confirmed `"status": "STOPPED"` after cleanup. No OpenAI key of this project's own was sent. Tool invocation through it remains unconfirmed (see row above). |
| `composed_tools` on BYOK Gemini (`composed_tools_llm_vendor="gemini"`) | `VERIFIED IN CODE` | Same live-verification treatment as the managed-OpenAI row, same day — this vendor option was kept, not replaced, when managed OpenAI became the default. |
| Agora `/speak` TTS broadcast (spoken summaries) | `VERIFIED IN CODE` | **Implemented 2026-08-31, audio delivery live-verified 2026-09-03** (see §10 update): `POST /api/agora/speak` calls the documented `POST /v2/projects/{appid}/agents/{agentId}/speak` schema against a real running agent; Agora accepted it (HTTP 200) and a real speech envelope was captured from the agent's actual RTC audio track via the page's own Web Audio analyser — silent for ~3.9s then a clean attack/peak/decay amplitude curve, not noise. Wired into `HandoffPanel`'s "🔊 Broadcast" button, sending the same `spoken_brief` text already generated for problem-statement item 11. |
| Agora `/think` custom instruction | `OFFICIAL DOCS ONLY` | **Schema confirmed 2026-09-01** (see §13) — full request/response shape fetched directly from official docs. Not called by Tocsin yet; proposed use is pushing real-time incident developments into a live voice session so the agent proactively announces them. |
| Agora `/update` agent configuration | `OFFICIAL DOCS ONLY` | **Schema confirmed 2026-09-01** (see §13) — supports updating `llm.system_messages`/`params` or `mllm.params` on a running agent without restart. Not called by Tocsin yet; proposed use is keeping a live agent's system prompt in sync as incident evidence changes. |
| Transcript delivery over RTM (v2.9) | `CREDENTIAL REQUIRED` | **Implemented 2026-08-31** (see §9): `POST /api/agora/rtm-token`, `advanced_features.enable_rtm`/`parameters.data_channel: "rtm"` on agent-join, and a real RTM login/subscribe/parse path on both `/` and `/voice-test`. RTM token issuance and login/subscribe machinery verified against real Agora credentials in a real browser; actual transcript-message delivery from a live speaking agent is not yet observed. |
| Emergency-intelligence MCP tool server (`mock-services/server.py`, 13 tools) | `CREDENTIAL REQUIRED` | The tool implementations themselves are real code calling real public APIs (USGS, NASA FIRMS, NOAA, OSM, Open-Meteo, GDACS, Copernicus CAMS) and a real/mock Slack path — this is independent of whether Agora ever invokes them via MCP. Live behavior for external-API-backed tools depends on those APIs; `notify_stakeholders` specifically requires `SLACK_WEBHOOK_URL` for live delivery. |
| Web SDK `stream-message` event subscription | `OFFICIAL DOCS ONLY` | The event itself is documented on Agora's Web SDK API reference. Confirmed present in code; not exercised against a live stream in this pass. |
| `agoraStreamDecoder.ts` wire-format parsing (pipe/base64/JSON patterns) | `UNVERIFIED` | No official Agora page confirms this exact wire format. Now covered by fixture tests (`transcript_hardening.test.ts`) proving deterministic, fail-safe (`null`) behavior on anything that doesn't match, but the format itself remains empirical. |
| Agora RTC channel-name policy (local regex) | `VERIFIED IN CODE` | Deliberately stricter than Agora's documented allowed character set; this is a local safety choice, not a claim about Agora's behavior, so it needed no live verification. |
| `agora-token-builder` (PyPI) as the token-generation implementation | `UNVERIFIED` | Functions correctly in this repo's own mocked tests; official docs name only the reference GitHub repo, not this specific PyPI package, as canonical. |
| Spoken audio summary broadcast into an active Agora channel | `VERIFIED IN CODE` | See the `/speak` row above — implemented 2026-08-31, audio delivery live-verified 2026-09-03. |

---

## Summary table

| Area | Status |
|---|---|
| RTC token role constants (1/publisher, 2/subscriber) | VERIFIED — MATCHES OFFICIAL DOCS |
| RTC token 24h max expiry alignment | VERIFIED — MATCHES OFFICIAL DOCS |
| `agora-token-builder` PyPI package as "the" official tool | UNVERIFIED AGAINST OFFICIAL DOCS (docs name only the GitHub reference repo) |
| ConvoAI join/leave URLs + Basic Auth scheme | VERIFIED — MATCHES OFFICIAL DOCS |
| `/api/agora/local-agent-session` reflecting real Agora agent state | Local-only by design, unchanged; the real Agora query endpoint is now separately wired and live-verified as `/api/agora/agent-status/{channel_name}` (2026-09-03) |
| Gemini `mllm` params/voice enum/turn_detection (`agora_vad`) | VERIFIED — MATCHES OFFICIAL DOCS |
| `gemini-3.1-flash-live-preview` as current model name | VERIFIED as of this fetch (preview model — expect rotation) |
| Hand-built Gemini WS URL as `mllm.url` | UNVERIFIED — necessity vs redundancy not confirmed |
| `mllm.mcp_servers` for tool-calling on Gemini Live | **CONFIRMED UNSUPPORTED, never sent** (2026-08-31) — docs describe `llm.mcp_servers` instead |
| `llm.mcp_servers` via new `composed_tools` pipeline | **VERIFIED IN CODE (2026-09-03)** — transport fixed from undocumented `"sse"` to documented `"streamable_http"`; Agora acceptance AND actual tool invocation both directly observed live |
| Web SDK `stream-message` event usage | VERIFIED — MATCHES OFFICIAL DOCS |
| `agoraStreamDecoder.ts` exact wire format | UNVERIFIED AGAINST OFFICIAL DOCS — now has fixture tests proving fail-safe (`null`) behavior on unrecognized payloads; wire format itself still unconfirmed |
| `.env.example` completeness for Agora vars | RESOLVED (2026-08-31) — `AGORA_CUSTOMER_ID`, `AGORA_CUSTOMER_SECRET`, `MCP_SERVER_PUBLIC_URL` now documented there |

No claim of production readiness is made anywhere above. Nothing in this document
should be read as confirming live behavior — every "VERIFIED" label here means
"matches official Agora documentation text," not "observed working against a live
Agora account." Live verification of §4 and §5 in particular requires real
`AGORA_CUSTOMER_ID`/`AGORA_CUSTOMER_SECRET`/`GEMINI_API_KEY` credentials and a running
voice session, which is outside the scope of this documentation-only research pass.
