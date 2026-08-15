"""
Agora Voice & Conversational AI Agent Endpoints
Handles RTC token issuance and agent session lifecycle.
"""

import logging
import os
import re
import time
from typing import Any, Literal

from agora_token_builder import RtcTokenBuilder
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

logger = logging.getLogger("tocsin.api.agora")

router = APIRouter(prefix="/api/agora", tags=["Agora Voice"])

# Regex for safe Agora channel name (alphanumeric, underscore, dash)
CHANNEL_NAME_REGEX = re.compile(r"^[a-zA-Z0-9_\-]{1,64}$")


class GenerateTokenRequest(BaseModel):
    channel_name: str = Field(
        min_length=1,
        max_length=64,
        description="Target Agora voice channel identifier (alphanumeric, -, _)",
        examples=["emergency-room-01"],
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
    channel_name: str = Field(min_length=1, max_length=64)
    agent_uid: int | str = Field(default=9999)
    language: str = Field(default="en-US")
    system_prompt: str | None = None
    mcp_server_url: str | None = None


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
            detail="Invalid channel_name format. Must be 1-64 characters matching [a-zA-Z0-9_-].",
        )

    app_id = os.getenv("AGORA_APP_ID", "").strip()
    app_certificate = os.getenv("AGORA_APP_CERTIFICATE", "").strip()

    if not app_id or not app_certificate:
        logger.error("Agora App ID or Certificate is missing from server configuration.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agora credentials not configured on backend server.",
        )

    current_timestamp = int(time.time())
    privilege_expired_ts = current_timestamp + request.expire_seconds
    role_constant = 1 if request.role == "publisher" else 2  # 1: Role_Publisher, 2: Role_Subscriber

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
            f"Generated RTC token for channel '{channel_name}', uid '{request.uid}', role '{request.role}'"
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
    summary="Start Agora Conversational AI Agent (Sub-step 3 Stub)",
    description="Launches Agora Gemini Live AI Voice Agent into the specified channel. Blocked pending Agora REST Customer ID/Secret.",
)
async def start_conversational_agent(request: StartAgentRequest) -> dict[str, Any]:
    """
    Sub-step 3 Stub:
    Calls Agora Voice Agent Builder / Conversational AI Engine REST API:
    - mllm.provider = "gemini"
    - mllm.api_key = GEMINI_API_KEY
    - mcp_servers = [mcp_server_url]
    - turn_detection = agora_vad
    """
    customer_id = os.getenv("AGORA_CUSTOMER_ID", "").strip()
    customer_secret = os.getenv("AGORA_CUSTOMER_SECRET", "").strip()
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()

    if not customer_id or not customer_secret:
        logger.warning("Sub-step 3 invoked without AGORA_CUSTOMER_ID/SECRET.")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Agora Conversational AI Agent REST credentials (AGORA_CUSTOMER_ID and AGORA_CUSTOMER_SECRET) "
                "are not configured. Sub-step 3 is waiting on Agora Console credentials."
            ),
        )

    if not gemini_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GEMINI_API_KEY is not configured.",
        )

    # Note on MCP URL: Agora cloud service requires a publicly reachable URL (e.g. ngrok or deployed host)
    # rather than internal Docker hostname (http://mock-services:8001).
    return {
        "status": "ready_for_substep_3",
        "channel_name": request.channel_name,
        "mllm_provider": "gemini",
    }
