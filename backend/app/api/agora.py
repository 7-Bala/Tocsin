"""
Agora Voice & Conversational AI Agent Endpoints
Handles RTC token issuance and Agora Conversational AI (Gemini Live MLLM + MCP Tools) lifecycle.
"""

import base64
import copy
import json
import logging
import os
import re
import time
from typing import Any, Literal

from agora_token_builder import RtcTokenBuilder
from fastapi import APIRouter, HTTPException, status
import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger("tocsin.api.agora")

router = APIRouter(prefix="/api/agora", tags=["Agora Voice"])

# Regex for safe Agora channel name (alphanumeric, underscore, dash)
CHANNEL_NAME_REGEX = re.compile(r"^[a-zA-Z0-9_\-]{1,64}$")

# In-memory registry of active agent IDs per channel
ACTIVE_AGENTS: dict[str, str] = {}

DEFAULT_EMERGENCY_PROMPT = (
  "You are Tocsin, a real-time voice AI emergency disaster coordinator. "
  "You are speaking to responders and citizens in an active crisis situation. "
  "Be calm, concise, professional, and direct. Keep your spoken responses short (1-3 sentences), "
  "prioritize safety and triage, verify details before giving recommendations, and communicate clearly. "
  "You have access to 6 real-time emergency disaster coordination tools via Model Context Protocol (MCP): "
  "1. get_weather_risk (check rainfall & weather hazard alerts) "
  "2. find_nearby_resource (locate shelters, hospitals, water supplies, pumping stations) "
  "3. calculate_eta (compute driving distance and route ETA) "
  "4. get_incident_status (check live incident severity and active symptoms) "
  "5. dispatch_resolution_action (dispatch aid, medical teams, resources, evacuations) "
  "6. notify_stakeholders (broadcast disaster bulletins). "
  "Call these tools proactively whenever responders ask for data, locations, or operational assistance."
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
    description="Gemini Live model version",
    examples=["gemini-3.1-flash-live-preview"],
  )
  system_prompt: str | None = Field(
    default=None,
    description="Custom system instructions for the conversational agent",
  )
  mcp_server_url: str | None = Field(
    default=None,
    description="Public HTTPS MCP server URL (defaults to MCP_SERVER_PUBLIC_URL env var if set)",
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
  if "properties" in sanitized and isinstance(sanitized["properties"], dict):
    if "token" in sanitized["properties"]:
      sanitized["properties"]["token"] = "[REDACTED_RTC_TOKEN]"
    if "mllm" in sanitized["properties"] and isinstance(
      sanitized["properties"]["mllm"], dict
    ):
      if "api_key" in sanitized["properties"]["mllm"]:
        sanitized["properties"]["mllm"]["api_key"] = "[REDACTED_GEMINI_KEY]"
      if "url" in sanitized["properties"]["mllm"]:
        raw_url = str(sanitized["properties"]["mllm"]["url"])
        sanitized["properties"]["mllm"]["url"] = re.sub(
          r"key=[^&]+", "key=[REDACTED_GEMINI_KEY]", raw_url
        )
    if "llm" in sanitized["properties"] and isinstance(
      sanitized["properties"]["llm"], dict
    ):
      if "api_key" in sanitized["properties"]["llm"]:
        sanitized["properties"]["llm"]["api_key"] = "[REDACTED_GEMINI_KEY]"
      if "url" in sanitized["properties"]["llm"]:
        raw_url = str(sanitized["properties"]["llm"]["url"])
        sanitized["properties"]["llm"]["url"] = re.sub(
          r"key=[^&]+", "key=[REDACTED_GEMINI_KEY]", raw_url
        )
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
  "/start-agent",
  summary="Start Agora Conversational AI Agent (Gemini Live MLLM + MCP Tools)",
  description="Launches a Google Gemini Live AI Voice Agent with MCP disaster tools into the specified Agora RTC voice channel.",
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

  prompt = (request.system_prompt or DEFAULT_EMERGENCY_PROMPT).strip()
  gemini_ws_url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={gemini_key}"

  # Official Agora ConvoAI REST v2 Join Schema (Gemini Live MLLM)
  payload: dict[str, Any] = {
    "name": f"tocsin_agent_{channel_name}",
    "properties": {
      "channel": channel_name,
      "token": agent_token,
      "agent_rtc_uid": str(request.agent_uid),
      "remote_rtc_uids": ["*"],
      "enable_string_uid": False,
      "idle_timeout": 120,
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
            "interrupt_duration_ms": 160,
            "prefix_padding_ms": 800,
            "silence_duration_ms": 640,
            "threshold": 0.5,
          },
        },
        "input_modalities": ["audio"],
        "output_modalities": ["audio"],
        "greeting_message": (
          "Tocsin emergency coordinator active with live tools. How can I"
          " assist?"
        ),
        "failure_message": "Sorry, I encountered an issue. Please try again.",
      },
    },
  }

  # Wire MCP Servers if public URL is configured
  mcp_url = (
    request.mcp_server_url or os.getenv("MCP_SERVER_PUBLIC_URL", "")
  ).strip()
  if mcp_url:
    sse_endpoint = (
      mcp_url if mcp_url.endswith("/sse") else f"{mcp_url.rstrip('/')}/sse"
    )
    mcp_config = [
      {
        "name": "tocsin_emergency_tools",
        "endpoint": sse_endpoint,
        "transport": "sse",
      }
    ]
    payload["properties"]["mllm"]["mcp_servers"] = mcp_config
    payload["properties"]["advanced_features"] = {"enable_tools": True}
    logger.info(
      f"Configured MCP server for agent: {sse_endpoint} (transport: sse)"
    )

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
      return {
        "status": "started",
        "agent_id": agent_id,
        "channel_name": channel_name,
        "agent_uid": request.agent_uid,
        "mllm_provider": "gemini",
        "voice": request.voice,
        "mcp_enabled": bool(mcp_url),
        "mcp_server_url": sse_endpoint if mcp_url else None,
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


@router.get(
  "/agent-status/{channel_name}",
  summary="Get Active Agent Status",
  description="Checks whether an active Conversational AI agent is registered for the specified channel.",
)
async def get_agent_status(channel_name: str) -> dict[str, Any]:
  agent_id = ACTIVE_AGENTS.get(channel_name)
  return {
    "channel_name": channel_name,
    "has_active_agent": bool(agent_id),
    "agent_id": agent_id,
  }
