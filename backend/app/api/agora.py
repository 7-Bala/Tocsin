"""
Agora Voice & Conversational AI Agent Endpoints
Handles RTC token issuance and Agora Conversational AI agent lifecycle.

Two voice pipelines are supported (see StartAgentRequest.voice_pipeline):
  - gemini_live (default): Agora's mllm pipeline, Gemini handles audio end-to-end.
    Lowest latency. Does NOT support MCP tool-calling (confirmed against official
    Agora docs — mcp_servers is documented only under `llm`, not `mllm`).
  - composed_tools: Agora's separate asr+llm+tts pipeline. Higher latency, but this is
    where Agora actually documents MCP tool-calling. Still uses Gemini as the
    reasoning model; ASR/TTS use Agora-managed credentials for Deepgram/MiniMax so no
    new third-party API keys are required. See docs/agora/RESEARCH.md §4 for the full
    research trail behind this split.
"""

import base64
import copy
import json
import logging
import os
import re
import time
from typing import Any, Literal

import httpx
from agora_token_builder import RtcTokenBuilder, RtmTokenBuilder  # type: ignore[import-untyped]
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

logger = logging.getLogger("tocsin.api.agora")

router = APIRouter(prefix="/api/agora", tags=["Agora Voice"])

# Regex for safe Agora channel name (alphanumeric, underscore, dash)
CHANNEL_NAME_REGEX = re.compile(r"^[a-zA-Z0-9_\-]{1,64}$")

# In-memory registry of active agent IDs per channel
ACTIVE_AGENTS: dict[str, str] = {}

# NOTE on MCP tool wiring (see docs/agora/RESEARCH.md §4): Agora's official release
# notes document tool-calling as an `llm.mcp_servers` field, not `mllm.mcp_servers`,
# and the dedicated Gemini Live MLLM documentation page makes no mention of tool
# calling at all. This is why `start_conversational_agent` below offers two pipelines
# (StartAgentRequest.voice_pipeline) — MCP tools are only ever wired into the
# `composed_tools` pipeline, where the documented `llm.mcp_servers` field actually
# lives. The default `gemini_live` pipeline never claims tool access. The base prompt
# below stays pipeline-agnostic (no tool claims either way) — MCP_TOOL_ROSTER_NOTICE,
# appended only for composed_tools when a tool server is configured, is what actually
# tells the model tools might be available.
DEFAULT_EMERGENCY_PROMPT = (
  "You are Tocsin, an intelligent AI emergency disaster coordinator and Incident Commander assistant. "
  "You are speaking to field responders, commanders, and citizens in active crisis situations. "
  "Be calm, professional, decisive, and rigorously grounded. Keep spoken responses concise (2-4 sentences). "
  "You do not have confirmed live access to any external tools in this conversation unless a tool call "
  "you attempt actually succeeds and returns a result. Never claim to have checked telemetry, weather, "
  "seismic, fire, alert, or mapping data unless a tool call for it actually executed and returned data in "
  "this session. If you are unsure whether a tool is available, say so explicitly rather than assuming it "
  "worked. "
  "CORE EVIDENCE ONTOLOGY & ANTI-HALLUCINATION RULES: "
  "Every factual claim must be traceable to a tool, telemetry, or user statement. If no evidence exists, state 'I don't have enough evidence to verify that.' Never fill gaps with plausible inventions. "
  "Explicitly distinguish the following categories without silently converting one into another: "
  "1. VERIFIED FACT: Directly supported by authoritative tools/sensors (e.g. USGS magnitude, SACHET official warning, telemetry). "
  "2. USER REPORT: Unverified observations from the caller (e.g. 'Caller reports rising floodwaters'). Never state a user report as a confirmed fact. "
  "3. MODEL/FORECAST: Numerical estimates (e.g. 'Open-Meteo model predicts low rainfall'). Forecasts are not ground measurements. "
  "4. MAPPED RESOURCE: Mapped facility locations from OSM. A mapped hospital does NOT verify operational status, staff, or bed capacity. State: 'OSM maps a facility X km away; operational status and capacity are unverified.' "
  "5. ROUTE ESTIMATE: OSRM route duration is a nominal model. It does NOT verify physical road passability during floods. State: 'Route model estimates X minutes; physical passability is unverified.' "
  "6. SATELLITE DETECTION: NASA FIRMS detection is a 'satellite-detected thermal anomaly', NOT a confirmed wildfire or structure fire until ground-verified. "
  "7. SEISMIC EVENT: USGS earthquake magnitude does NOT confirm building structural collapse without field inspection. "
  "8. UNKNOWN INFORMATION: Unknown status must be explicitly stated as UNKNOWN. "
  "EVIDENCE CONFLICT RULE: When sources disagree (e.g. user reports flooding while weather model shows LOW rain, SACHET has no active alert, and local telemetry detects overflow), you MUST NOT choose one silently or claim 'no flood'. State the official/model data, state the user report, state the telemetry, explicitly identify the conflict, and explain that localized flash incidents may not yet appear in regional alert products. "
  "ACTION SAFETY PROTOCOL: You must NEVER execute high-impact emergency actions (evacuations, boat dispatches, pump activations) autonomously. State supporting evidence, state uncertainties, state rationale, and call propose_incident_action to queue the action in PENDING_APPROVAL for Incident Commander review. "
  "OPERATIONAL RESPONSE STRUCTURE: When addressing operational questions, internally structure your assessment with: VERIFIED facts, REPORTED user claims, UNCERTAIN gaps, reasoned ASSESSMENT, RECOMMENDATION, and PROPOSED ACTION."
)

# Appended to the prompt only when the composed_tools pipeline is active AND an MCP
# server URL is configured (see `start_conversational_agent`). The `llm.mcp_servers`
# wiring itself is now confirmed against official Agora docs (unlike the earlier
# mllm.mcp_servers attempt) — what remains unverified is only whether a *live* session
# actually invokes a tool through it, so this is still written to make the model treat
# every tool call as attempted, not guaranteed, and to prefer stating that a tool
# result is unavailable over inventing one.
MCP_TOOL_ROSTER_NOTICE = (
  "An MCP tool server has been configured for this session, exposing up to 13 emergency "
  "intelligence and response tools if the connection succeeds: get_incident_status, "
  "get_weather_risk, get_official_emergency_alerts, search_emergency_infrastructure, "
  "find_nearby_resource, calculate_eta, get_earthquake_activity, get_active_fire_hotspots, "
  "get_global_disaster_alerts, get_air_quality_hazards, propose_incident_action, "
  "dispatch_resolution_action, notify_stakeholders. Select only tools relevant to the "
  "incident (e.g. for floods: get_incident_status, get_weather_risk, "
  "get_official_emergency_alerts, search_emergency_infrastructure, find_nearby_resource, "
  "calculate_eta). This tool wiring matches Agora's documented schema, but no live "
  "session has yet confirmed a tool call actually completes — if a tool call does not "
  "return a result, say so plainly rather than assuming it executed."
)


class GenerateTokenRequest(BaseModel):
  channel_name: str = Field(
    min_length=1,
    max_length=64,
    description="Target Agora voice channel identifier (alphanumeric, -, _)",
    examples=["tocsin-emergency-room"],
  )
  uid: int | str = Field(
    default=0,
    description="Numeric user ID (0 for auto-assign) or account string",
    examples=[1001],
  )
  role: Literal["publisher", "subscriber"] = Field(
    default="publisher",
    description="RTC role in the voice channel",
  )
  expire_seconds: int = Field(
    default=3600,
    ge=60,
    le=86400,
    description="Token expiration duration in seconds",
  )


class TokenResponse(BaseModel):
  token: str
  app_id: str
  channel_name: str
  uid: int | str
  expires_in_seconds: int


class GenerateRtmTokenRequest(BaseModel):
  user_account: str = Field(
    min_length=1,
    max_length=64,
    description=(
      "RTM user account (string identity, distinct from the numeric RTC uid) "
      "used to log into the Agora Signaling (RTM) service."
    ),
    examples=["tocsin-viewer-1"],
  )
  expire_seconds: int = Field(
    default=3600,
    ge=60,
    le=86400,
    description="Token expiration duration in seconds",
  )


class RtmTokenResponse(BaseModel):
  token: str
  app_id: str
  user_account: str
  expires_in_seconds: int


class StartAgentRequest(BaseModel):
  channel_name: str = Field(
    min_length=1,
    max_length=64,
    description="Target Agora voice channel to join the agent into",
    examples=["tocsin-emergency-room"],
  )
  agent_uid: int = Field(
    default=9999,
    description="Numeric RTC UID for the agent participant in the channel",
    examples=[9999],
  )
  voice: str = Field(
    default="Puck",
    description="Gemini Live voice personality (Puck, Charon, Aoede, Fenrir, Kore, Leda, Orus, Zephyr)",
    examples=["Puck"],
  )
  model: str = Field(
    default="gemini-3.1-flash-live-preview",
    description=(
      "Gemini model for the gemini_live pipeline only -- this must be a model "
      "that supports the WebSocket Live API (bidiGenerateContent). Ignored for "
      "voice_pipeline='composed_tools', which uses composed_tools_llm_model "
      "instead (a live-only model here would break composed_tools -- confirmed "
      "live 2026-08-31: gemini-3.1-flash-live-preview returns HTTP 400 'only "
      "supports real-time bidirectional streaming via WebSocket' when called "
      "through the plain streamGenerateContent REST endpoint composed_tools "
      "actually uses)."
    ),
    examples=["gemini-3.1-flash-live-preview"],
  )
  composed_tools_llm_model: str = Field(
    default="gemini-3.6-flash",
    description=(
      "Gemini model for the composed_tools pipeline's llm block -- must support "
      "the plain streamGenerateContent REST endpoint (not a Live-only model). "
      "Ignored for voice_pipeline='gemini_live'."
    ),
    examples=["gemini-3.6-flash"],
  )
  system_prompt: str | None = Field(
    default=None,
    description="Custom system instructions for the conversational agent",
  )
  mcp_server_url: str | None = Field(
    default=None,
    description="Public HTTPS MCP server URL (defaults to MCP_SERVER_PUBLIC_URL env var if set)",
  )
  voice_pipeline: Literal["gemini_live", "composed_tools"] = Field(
    default="gemini_live",
    description=(
      "'gemini_live' (default, unchanged behavior): Agora's mllm pipeline — Gemini "
      "handles audio end-to-end with the lowest latency, but Agora's official docs do "
      "not support MCP tool-calling in this mode (see docs/agora/RESEARCH.md §4). "
      "'composed_tools': Agora's separate asr+llm+tts pipeline — higher latency (three "
      "hops instead of one native audio model), but this is the pipeline Agora's docs "
      "actually document `llm.mcp_servers` under, so MCP tool-calling can genuinely be "
      "wired here. Still uses Gemini as the reasoning model (via `style: 'gemini'` "
      "with our own GEMINI_API_KEY, matching how the gemini_live pipeline builds its "
      "URL) — ASR and TTS use Agora-managed credentials (credential_mode: 'managed') "
      "for Deepgram and MiniMax respectively, so no new third-party API keys are "
      "required, but this does draw on Agora's own managed billing for those two "
      "steps. NOT YET LIVE-VERIFIED — the request is built per official Agora "
      "documentation, but no live credentialed session has confirmed Agora accepts it "
      "or that the agent actually invokes a tool through it."
    ),
  )


class SpeakRequest(BaseModel):
  channel_name: str = Field(
    min_length=1,
    max_length=64,
    description="Target Agora voice channel whose active agent should speak",
    examples=["tocsin-emergency-room"],
  )
  text: str = Field(
    min_length=1,
    max_length=512,
    description=(
      "Text to synthesize and broadcast. Agora's documented limit is 512 bytes; "
      "this is enforced as 512 characters here as a conservative proxy (a UTF-8 "
      "string with multi-byte characters could exceed 512 bytes at fewer than 512 "
      "characters — Agora's own API is the final authority and will reject an "
      "oversized request)."
    ),
    examples=["Handoff brief: two open action items, one overdue."],
  )
  priority: Literal["INTERRUPT", "APPEND", "IGNORE"] = Field(
    default="INTERRUPT",
    description=(
      "How this broadcast interacts with the agent's current speech, per official "
      "Agora docs (docs.agora.io/en/api-reference/api-ref/conversational-ai/speak): "
      "INTERRUPT stops current speech and speaks immediately (default); APPEND "
      "queues after current speech finishes; IGNORE drops the request if the agent "
      "is already speaking."
    ),
  )
  interruptable: bool = Field(
    default=True,
    description="Whether this broadcast can itself be interrupted by the next event.",
  )


class StopAgentRequest(BaseModel):
  channel_name: str = Field(
    min_length=1,
    max_length=64,
    description="Target Agora voice channel",
    examples=["tocsin-emergency-room"],
  )
  agent_id: str | None = Field(
    default=None,
    description="Agent session ID (if known; otherwise resolved from active channel registry)",
  )


def sanitize_payload(payload: dict[str, Any]) -> dict[str, Any]:
  """Create a safe-to-log copy of the request payload with secrets redacted."""
  sanitized = copy.deepcopy(payload)
  props = sanitized.get("properties")
  if not isinstance(props, dict):
    return sanitized

  if "token" in props:
    props["token"] = "[REDACTED_RTC_TOKEN]"

  # Applies to every vendor block that can carry a credential — mllm and llm today
  # (both BYOK, straight to our own Gemini key), and defensively asr/tts too in case a
  # future change adds BYOK credentials there (today they use credential_mode
  # "managed" and carry no secret, but this redaction costs nothing to keep general).
  for block_name in ("mllm", "llm", "asr", "tts"):
    block = props.get(block_name)
    if not isinstance(block, dict):
      continue
    if "api_key" in block:
      block["api_key"] = "[REDACTED_API_KEY]"
    if isinstance(block.get("url"), str):
      block["url"] = re.sub(r"key=[^&]+", "key=[REDACTED_API_KEY]", block["url"])
    headers = block.get("headers")
    if isinstance(headers, dict):
      for header_key in list(headers.keys()):
        if header_key.lower() in ("authorization", "x-api-key"):
          headers[header_key] = "[REDACTED_HEADER]"

  return sanitized


@router.post(
  "/token",
  response_model=TokenResponse,
  summary="Generate Agora RTC Token",
  description="Generates a short-lived RTC authentication token for client voice channel connection.",
)
async def generate_rtc_token(request: GenerateTokenRequest) -> TokenResponse:
  """Generate short-lived Agora RTC token."""
  channel_name = request.channel_name.strip()
  if not CHANNEL_NAME_REGEX.match(channel_name):
    raise HTTPException(
      status_code=status.HTTP_400_BAD_REQUEST,
      detail=(
        "Invalid channel_name format. Must be 1-64 characters matching"
        " [a-zA-Z0-9_-]."
      ),
    )

  app_id = os.getenv("AGORA_APP_ID", "").strip()
  app_certificate = os.getenv("AGORA_APP_CERTIFICATE", "").strip()

  if not app_id or not app_certificate:
    logger.error(
      "Agora App ID or Certificate is missing from server configuration."
    )
    raise HTTPException(
      status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
      detail="Agora credentials not configured on backend server.",
    )

  current_timestamp = int(time.time())
  privilege_expired_ts = current_timestamp + request.expire_seconds
  role_constant = (
    1 if request.role == "publisher" else 2
  )  # 1: Role_Publisher, 2: Role_Subscriber

  try:
    if isinstance(request.uid, int):
      token = RtcTokenBuilder.buildTokenWithUid(
        appId=app_id,
        appCertificate=app_certificate,
        channelName=channel_name,
        uid=request.uid,
        role=role_constant,
        privilegeExpiredTs=privilege_expired_ts,
      )
    else:
      token = RtcTokenBuilder.buildTokenWithAccount(
        appId=app_id,
        appCertificate=app_certificate,
        channelName=channel_name,
        account=str(request.uid),
        role=role_constant,
        privilegeExpiredTs=privilege_expired_ts,
      )

    logger.info(
      f"Generated RTC token for channel '{channel_name}', uid '{request.uid}',"
      f" role '{request.role}'"
    )
    return TokenResponse(
      token=token,
      app_id=app_id,
      channel_name=channel_name,
      uid=request.uid,
      expires_in_seconds=request.expire_seconds,
    )
  except (ValueError, TypeError, KeyError, RuntimeError) as exc:
    logger.error(f"Failed to generate RTC token: {exc}")
    raise HTTPException(
      status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
      detail="Failed to generate RTC token.",
    )


@router.post(
  "/rtm-token",
  response_model=RtmTokenResponse,
  summary="Generate Agora RTM (Signaling) Token",
  description=(
    "Generates a short-lived Agora RTM token, required to receive live transcript "
    "events. Per Agora's Conversational AI docs "
    "(docs.agora.io/en/conversational-ai/develop/transcripts), transcript delivery "
    "is a Signaling (RTM) channel message, not an RTC event — the browser needs a "
    "separate RTM login alongside its RTC connection to receive it. See "
    "docs/agora/RESEARCH.md §5 for the full research trail."
  ),
)
async def generate_rtm_token(request: GenerateRtmTokenRequest) -> RtmTokenResponse:
  """Generate short-lived Agora RTM token for the Conversational AI transcript path."""
  app_id = os.getenv("AGORA_APP_ID", "").strip()
  app_certificate = os.getenv("AGORA_APP_CERTIFICATE", "").strip()

  if not app_id or not app_certificate:
    logger.error(
      "Agora App ID or Certificate is missing from server configuration."
    )
    raise HTTPException(
      status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
      detail="Agora credentials not configured on backend server.",
    )

  current_timestamp = int(time.time())
  privilege_expired_ts = current_timestamp + request.expire_seconds

  try:
    token = RtmTokenBuilder.buildToken(
      app_id,
      app_certificate,
      request.user_account,
      1,  # Role_Rtm_User
      privilege_expired_ts,
    )
    logger.info(f"Generated RTM token for user_account '{request.user_account}'")
    return RtmTokenResponse(
      token=token,
      app_id=app_id,
      user_account=request.user_account,
      expires_in_seconds=request.expire_seconds,
    )
  except (ValueError, TypeError, KeyError, RuntimeError) as exc:
    logger.error(f"Failed to generate RTM token: {exc}")
    raise HTTPException(
      status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
      detail="Failed to generate RTM token.",
    )


@router.post(
  "/start-agent",
  summary="Start Agora Conversational AI Agent",
  description=(
    "Launches a Gemini-powered voice agent into the specified Agora RTC voice channel. "
    "Two pipelines available via voice_pipeline: 'gemini_live' (default, lowest "
    "latency, no MCP tool support) or 'composed_tools' (higher latency, MCP tools "
    "wired per official Agora docs — see StartAgentRequest.voice_pipeline)."
  ),
)
async def start_conversational_agent(
  request: StartAgentRequest,
) -> dict[str, Any]:
  """Calls Agora Conversational AI Engine REST API to join Gemini Live MLLM into the channel."""
  channel_name = request.channel_name.strip()
  if not CHANNEL_NAME_REGEX.match(channel_name):
    raise HTTPException(
      status_code=status.HTTP_400_BAD_REQUEST,
      detail=(
        "Invalid channel_name format. Must be 1-64 characters matching"
        " [a-zA-Z0-9_-]."
      ),
    )

  app_id = os.getenv("AGORA_APP_ID", "").strip()
  app_certificate = os.getenv("AGORA_APP_CERTIFICATE", "").strip()
  customer_id = os.getenv("AGORA_CUSTOMER_ID", "").strip()
  customer_secret = os.getenv("AGORA_CUSTOMER_SECRET", "").strip()
  gemini_key = os.getenv("GEMINI_API_KEY", "").strip()

  if not app_id or not app_certificate:
    raise HTTPException(
      status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
      detail="AGORA_APP_ID and AGORA_APP_CERTIFICATE are not configured.",
    )

  if not customer_id or not customer_secret:
    raise HTTPException(
      status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
      detail=(
        "AGORA_CUSTOMER_ID and AGORA_CUSTOMER_SECRET are not configured on the"
        " backend server."
      ),
    )

  if not gemini_key:
    raise HTTPException(
      status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
      detail="GEMINI_API_KEY is not configured on the backend server.",
    )

  # Generate short-lived RTC token specifically for the agent participant
  expire_seconds = 3600
  current_timestamp = int(time.time())
  agent_token = RtcTokenBuilder.buildTokenWithUid(
    appId=app_id,
    appCertificate=app_certificate,
    channelName=channel_name,
    uid=request.agent_uid,
    role=1,  # Role_Publisher
    privilegeExpiredTs=current_timestamp + expire_seconds,
  )

  # Construct Basic Auth header
  auth_str = f"{customer_id}:{customer_secret}"
  b64_auth = base64.b64encode(auth_str.encode("utf-8")).decode("utf-8")
  headers = {
    "Authorization": f"Basic {b64_auth}",
    "Content-Type": "application/json",
  }

  # Resolve MCP server config before building the prompt, so the tool roster notice
  # (see MCP_TOOL_ROSTER_NOTICE) is only appended when a tool server is actually wired.
  raw_mcp = request.mcp_server_url or os.getenv("MCP_SERVER_PUBLIC_URL") or ""
  mcp_url = raw_mcp.strip()
  # MCP tools are only ever wired into the composed_tools pipeline (below) — Agora's
  # own release notes document mcp_servers under `llm`, and the Gemini Live `mllm`
  # documentation page makes no mention of tool-calling at all. See
  # docs/agora/RESEARCH.md §4 for the full research trail.
  mcp_requested = bool(mcp_url) and request.voice_pipeline == "composed_tools"

  prompt = (request.system_prompt or DEFAULT_EMERGENCY_PROMPT).strip()
  if mcp_requested and not request.system_prompt:
    prompt = f"{prompt}\n\n{MCP_TOOL_ROSTER_NOTICE}"

  sse_endpoint: str | None = None
  payload: dict[str, Any]

  if request.voice_pipeline == "gemini_live":
    # Unchanged from the original implementation, MINUS mcp_servers: official docs
    # confirm this field is not supported here (docs/agora/RESEARCH.md §4). Gemini
    # handles audio end-to-end — no separate asr/tts hop, lowest latency.
    gemini_ws_url = (
      "wss://generativelanguage.googleapis.com/ws/"
      f"google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={gemini_key}"
    )
    payload = {
      "name": f"tocsin_agent_{channel_name}",
      "properties": {
        "channel": channel_name,
        "token": agent_token,
        "agent_rtc_uid": str(request.agent_uid),
        "remote_rtc_uids": ["*"],
        "enable_string_uid": False,
        "idle_timeout": 120,
        "advanced_features": {"enable_rtm": True},
        "parameters": {"data_channel": "rtm"},
        "mllm": {
          "enable": True,
          "vendor": "gemini",
          "url": gemini_ws_url,
          "api_key": gemini_key,
          "params": {
            "model": request.model,
            "instructions": prompt,
            "voice": request.voice,
            "affective_dialog": False,
            "proactive_audio": False,
            "transcribe_agent": True,
            "transcribe_user": True,
            "http_options": {"api_version": "v1beta"},
          },
          "turn_detection": {
            "mode": "agora_vad",
            "agora_vad_config": {
              "interrupt_duration_ms": 500,
              "prefix_padding_ms": 800,
              "silence_duration_ms": 640,
              "threshold": 0.5,
            },
          },
          "input_modalities": ["audio"],
          "output_modalities": ["audio"],
          "greeting_message": (
            "Tocsin emergency coordinator active. How can I assist?"
          ),
          "failure_message": "Sorry, I encountered an issue. Please try again.",
        },
      },
    }

  else:  # composed_tools: separate asr + llm + tts pipeline, per official docs
    # Higher latency than gemini_live (three hops instead of one native audio model),
    # chosen only when the caller explicitly wants MCP tool-calling, which Agora's
    # docs only support here. Schema confirmed against:
    #   - ASR managed-credential example: docs.agora.io/en/conversational-ai/models/asr/overview
    #   - LLM managed-credential example: docs.agora.io/en/conversational-ai/models/llm/openai
    #   - Gemini as a plain llm vendor (style: "gemini", raw URL+key, BYOK):
    #     docs.agora.io/en/conversational-ai/models/llm/gemini
    #   - TTS managed-credential example: docs.agora.io/en/conversational-ai/models/tts/overview
    #   - mcp_servers item shape + advanced_features.enable_tools:
    #     docs.agora.io/en/api-reference/api-ref/conversational-ai/join
    # ASR (Deepgram) and TTS (MiniMax) use credential_mode "managed" — Agora supplies
    # those credentials and bills them to the Agora account; no new third-party API key
    # is added to this project. LLM stays on our own GEMINI_API_KEY (BYOK) so the
    # actual reasoning model doesn't change, only how tool-calling reaches it.
    gemini_llm_url = (
      "https://generativelanguage.googleapis.com/v1beta/models/"
      f"{request.composed_tools_llm_model}:streamGenerateContent?alt=sse&key={gemini_key}"
    )
    payload = {
      "name": f"tocsin_agent_{channel_name}",
      "properties": {
        "channel": channel_name,
        "token": agent_token,
        "agent_rtc_uid": str(request.agent_uid),
        "remote_rtc_uids": ["*"],
        "enable_string_uid": False,
        "idle_timeout": 120,
        "advanced_features": {"enable_rtm": True},
        "parameters": {"data_channel": "rtm"},
        "asr": {
          "credential_mode": "managed",
          "vendor": "deepgram",
          # `url` is required even in managed-credential mode -- confirmed against a
          # live HTTP 400 from Agora's real join API ("Invalid value at
          # properties.asr.params.url: required field is missing") and against
          # docs.agora.io/en/conversational-ai/models/asr/overview, which gives this
          # exact literal value for Deepgram. `credential_mode: "managed"` only means
          # Agora supplies the API key/auth, not that the endpoint URL is implied.
          "params": {
            "url": "wss://api.deepgram.com/v1/listen",
            "model": "nova-3",
            "language": "en",
          },
        },
        "llm": {
          # Gemini is not in Agora's documented `vendor` enum for the llm block
          # (openai | azure | xai | custom) — "custom" plus style: "gemini" is the
          # doc-consistent way to point the llm step at our own Gemini endpoint,
          # matching the same BYOK URL-with-embedded-key pattern the gemini_live
          # pipeline already uses above.
          "vendor": "custom",
          "style": "gemini",
          "url": gemini_llm_url,
          "api_key": gemini_key,
          "system_messages": [{"role": "system", "content": prompt}],
          "max_history": 32,
          "params": {"model": request.composed_tools_llm_model},
          "greeting_message": "Tocsin emergency coordinator active. How can I assist?",
          "failure_message": "Sorry, I encountered an issue. Please try again.",
        },
        "tts": {
          "credential_mode": "managed",
          "vendor": "minimax",
          # `url` is required even in managed mode -- same finding as the asr block
          # above, confirmed against a live HTTP 400 from Agora's real join API and
          # against docs.agora.io/en/conversational-ai/models/tts/minimax's managed
          # example (this is the managed-mode URL; BYOK uses a different host).
          "params": {
            "url": "wss://api.minimax.io/ws/v1/t2a_v2",
            "model": "speech-2.8-turbo",
            "voice_setting": {"voice_id": "English_captivating_female1", "speed": 1.0},
            "audio_setting": {"sample_rate": 44100},
          },
        },
      },
    }
    if mcp_requested:
      sse_endpoint = mcp_url if mcp_url.endswith("/sse") else f"{mcp_url.rstrip('/')}/sse"
      payload["properties"]["llm"]["mcp_servers"] = [
        {
          "name": "tocsin-emergency-tools",
          "endpoint": sse_endpoint,
          "transport": "sse",
        }
      ]
      payload["properties"]["advanced_features"]["enable_tools"] = True
      logger.info(f"Configured MCP server for agent: {sse_endpoint} (transport: sse)")

  agora_url = (
    f"https://api.agora.io/api/conversational-ai-agent/v2/projects/{app_id}/join"
  )

  # Redacted logging of outbound request for inspection
  sanitized = sanitize_payload(payload)
  logger.info(
    f"Outgoing start-agent request to Agora URL: {agora_url}\nPayload:"
    f" {json.dumps(sanitized, indent=2)}"
  )

  try:
    async with httpx.AsyncClient(timeout=12.0) as client:
      resp = await client.post(agora_url, json=payload, headers=headers)
      logger.info(
        f"Agora ConvoAI join response HTTP {resp.status_code}: {resp.text}"
      )

      if resp.status_code not in (200, 201):
        err_msg = resp.text
        logger.error(
          f"Agora ConvoAI join failed (HTTP {resp.status_code}): {err_msg}"
        )
        raise HTTPException(
          status_code=status.HTTP_502_BAD_GATEWAY,
          detail=(
            f"Agora Conversational AI service error (HTTP {resp.status_code}):"
            f" {err_msg}"
          ),
        )

      data = resp.json()
      agent_id = (
        data.get("agent_id")
        or data.get("id")
        or f"agent_{channel_name}_{request.agent_uid}"
      )
      ACTIVE_AGENTS[channel_name] = agent_id

      logger.info(
        f"Agora Conversational AI agent started successfully (agent_id:"
        f" {agent_id}) for channel '{channel_name}'"
      )
      if request.voice_pipeline == "gemini_live":
        mcp_status = (
          "NOT_SUPPORTED: the gemini_live (mllm) pipeline does not support MCP tool "
          "wiring per official Agora docs (mcp_servers is documented only under "
          "properties.llm, not properties.mllm). Request voice_pipeline="
          "'composed_tools' to enable it. See docs/agora/RESEARCH.md §4."
          if mcp_url
          else "NOT_REQUESTED"
        )
      else:
        mcp_status = (
          "WIRED PER OFFICIAL DOCS — NOT YET LIVE-VERIFIED: properties.llm.mcp_servers "
          "+ advanced_features.enable_tools were sent, matching the documented schema "
          "at docs.agora.io/en/api-reference/api-ref/conversational-ai/join. No live "
          "credentialed session has yet confirmed Agora accepted this or that the "
          "agent actually invoked a tool through it. Treat as CREDENTIAL REQUIRED, "
          "not confirmed working, until verified. See docs/agora/RESEARCH.md §4."
          if mcp_requested
          else "NOT_REQUESTED"
        )

      return {
        "status": "started",
        "agent_id": agent_id,
        "channel_name": channel_name,
        "agent_uid": request.agent_uid,
        "voice_pipeline": request.voice_pipeline,
        "llm_provider": "gemini",
        "voice": request.voice,
        "mcp_enabled": mcp_requested,
        "mcp_server_url": sse_endpoint,
        "mcp_tool_calling_status": mcp_status,
      }
  except httpx.HTTPError as exc:
    logger.error(f"Network error connecting to Agora ConvoAI REST API: {exc}")
    raise HTTPException(
      status_code=status.HTTP_502_BAD_GATEWAY,
      detail=f"Network error communicating with Agora REST API: {exc}",
    )


@router.post(
  "/stop-agent",
  summary="Stop Agora Conversational AI Agent",
  description="Stops an active Agora Gemini Live AI Voice Agent session in the specified channel.",
)
async def stop_conversational_agent(request: StopAgentRequest) -> dict[str, Any]:
  """Calls Agora Conversational AI Engine REST API to remove the agent from the channel."""
  channel_name = request.channel_name.strip()
  agent_id = request.agent_id or ACTIVE_AGENTS.get(channel_name)

  app_id = os.getenv("AGORA_APP_ID", "").strip()
  customer_id = os.getenv("AGORA_CUSTOMER_ID", "").strip()
  customer_secret = os.getenv("AGORA_CUSTOMER_SECRET", "").strip()

  if not agent_id:
    return {
      "status": "not_running",
      "message": f"No active agent registered for channel '{channel_name}'.",
      "channel_name": channel_name,
    }

  auth_str = f"{customer_id}:{customer_secret}"
  b64_auth = base64.b64encode(auth_str.encode("utf-8")).decode("utf-8")
  headers = {
    "Authorization": f"Basic {b64_auth}",
    "Content-Type": "application/json",
  }

  agora_url = f"https://api.agora.io/api/conversational-ai-agent/v2/projects/{app_id}/agents/{agent_id}/leave"

  logger.info(
    f"Dispatching stop-agent to Agora REST API for agent '{agent_id}' in channel"
    f" '{channel_name}'"
  )

  try:
    async with httpx.AsyncClient(timeout=8.0) as client:
      resp = await client.post(agora_url, headers=headers)
      if resp.status_code in (200, 204):
        ACTIVE_AGENTS.pop(channel_name, None)
        logger.info(f"Agent '{agent_id}' stopped successfully.")
        return {
          "status": "stopped",
          "agent_id": agent_id,
          "channel_name": channel_name,
        }
      else:
        logger.warning(
          f"Agora leave returned HTTP {resp.status_code}: {resp.text}"
        )
        ACTIVE_AGENTS.pop(channel_name, None)
        return {
          "status": "stopped_with_warning",
          "agent_id": agent_id,
          "detail": resp.text,
        }
  except httpx.HTTPError as exc:
    logger.error(f"Failed to communicate with Agora stop-agent endpoint: {exc}")
    ACTIVE_AGENTS.pop(channel_name, None)
    return {
      "status": "stopped_locally",
      "agent_id": agent_id,
      "warning": str(exc),
    }


@router.post(
  "/speak",
  summary="Broadcast a text message via the active agent's TTS (spoken summary delivery)",
  description=(
    "Calls Agora's documented POST /v2/projects/{appid}/agents/{agentId}/speak "
    "endpoint to have the currently-running Conversational AI agent speak text into "
    "its voice channel — the mechanism for delivering Tocsin's written summaries "
    "(e.g. GET /api/incidents/{id}/handoff's spoken_brief) as live audio. Requires "
    "an agent already running in the target channel (started via /start-agent); "
    "returns 404 if none is tracked. See docs/agora/RESEARCH.md §4/§9 for the "
    "research trail — this endpoint is CREDENTIAL REQUIRED / NOT YET LIVE-VERIFIED "
    "until a real credentialed session confirms Agora accepts the call and audio is "
    "actually heard in the channel."
  ),
)
async def speak_into_channel(request: SpeakRequest) -> dict[str, Any]:
  """Broadcast text as spoken audio through the active agent in a channel."""
  channel_name = request.channel_name.strip()
  agent_id = ACTIVE_AGENTS.get(channel_name)

  if not agent_id:
    raise HTTPException(
      status_code=status.HTTP_404_NOT_FOUND,
      detail=(
        f"No active agent tracked for channel '{channel_name}'. Start one via "
        "/api/agora/start-agent first — this endpoint speaks through an existing "
        "agent session, it does not create one."
      ),
    )

  app_id = os.getenv("AGORA_APP_ID", "").strip()
  customer_id = os.getenv("AGORA_CUSTOMER_ID", "").strip()
  customer_secret = os.getenv("AGORA_CUSTOMER_SECRET", "").strip()

  if not app_id or not customer_id or not customer_secret:
    raise HTTPException(
      status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
      detail=(
        "AGORA_APP_ID, AGORA_CUSTOMER_ID, and AGORA_CUSTOMER_SECRET are not "
        "configured on the backend server."
      ),
    )

  auth_str = f"{customer_id}:{customer_secret}"
  b64_auth = base64.b64encode(auth_str.encode("utf-8")).decode("utf-8")
  headers = {
    "Authorization": f"Basic {b64_auth}",
    "Content-Type": "application/json",
  }

  payload = {
    "text": request.text,
    "priority": request.priority,
    "interruptable": request.interruptable,
  }

  agora_url = (
    f"https://api.agora.io/api/conversational-ai-agent/v2/projects/{app_id}"
    f"/agents/{agent_id}/speak"
  )

  logger.info(
    f"Outgoing speak request to Agora URL: {agora_url} for channel"
    f" '{channel_name}' (agent_id: {agent_id}, priority: {request.priority},"
    f" text_length: {len(request.text)})"
  )

  try:
    async with httpx.AsyncClient(timeout=12.0) as client:
      resp = await client.post(agora_url, json=payload, headers=headers)
      logger.info(f"Agora speak response HTTP {resp.status_code}: {resp.text}")

      if resp.status_code not in (200, 201):
        err_msg = resp.text
        logger.error(f"Agora speak request failed (HTTP {resp.status_code}): {err_msg}")
        raise HTTPException(
          status_code=status.HTTP_502_BAD_GATEWAY,
          detail=(
            f"Agora Conversational AI speak error (HTTP {resp.status_code}):"
            f" {err_msg}"
          ),
        )

      data = resp.json() if resp.text else {}
      return {
        "status": "spoken",
        "channel_name": channel_name,
        "agent_id": agent_id,
        "text_length": len(request.text),
        "priority": request.priority,
        "agora_response": data,
      }
  except httpx.HTTPError as exc:
    logger.error(f"Network error connecting to Agora speak REST API: {exc}")
    raise HTTPException(
      status_code=status.HTTP_502_BAD_GATEWAY,
      detail=f"Network error communicating with Agora REST API: {exc}",
    )


@router.get(
  "/local-agent-session/{channel_name}",
  summary="Get Locally-Tracked Agent Session State",
  description=(
    "Returns Tocsin's own in-memory record of the last agent_id started for this "
    "channel. This is NOT a live query against Agora's Conversational AI service: "
    "Agora publishes a real 'Query agent status' REST endpoint "
    "(docs.agora.io/en/conversational-ai/rest-api/agent/query), but this pass could "
    "not confirm its exact URL/response schema from official docs, so it is not "
    "called here. This endpoint can be stale or wrong if the backend process "
    "restarted (registry is cleared) or if Agora already stopped the agent "
    "server-side (idle timeout, error) without Tocsin being told."
  ),
)
async def get_local_agent_session_state(channel_name: str) -> dict[str, Any]:
  """Local-only session lookup. Does not call Agora; see docstring above."""
  agent_id = ACTIVE_AGENTS.get(channel_name)
  return {
    "channel_name": channel_name,
    "has_local_agent_record": bool(agent_id),
    "agent_id": agent_id,
    "source": "tocsin_local_in_memory_registry",
    "live_agora_state_verified": False,
    "note": (
      "This reflects Tocsin's local record only, not a live Agora query. See "
      "docs/agora/RESEARCH.md for details."
    ),
  }
