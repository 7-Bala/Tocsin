"""
Tocsin Mock Services - FastMCP Tool Server
Exposes 13 specialized disaster coordination and intelligence tools with standardized evidence provenance.
"""

import logging
import math
import os
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any, Literal

import httpx
from fastmcp import FastMCP

# Configure structured logging
LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger: logging.Logger = logging.getLogger("tocsin.mcp_tools")

# Backend service URL for internal resolution / status coordination
BACKEND_URL: str = os.getenv("BACKEND_URL", "http://localhost:8000").rstrip("/")
USER_AGENT: str = "TocsinDisasterCoordination/1.0 (contact: hackathon@tocsin.app)"

# In-memory TTL Cache for official alert queries (prevents remote feed hammering)
_ALERT_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_CACHE_TTL_SECONDS = 60.0

# Initialize FastMCP Server
mcp = FastMCP(
    "TocsinEmergencyTools",
    instructions=(
        "Real-time disaster coordination tools for weather risk, seismic events (USGS), "
        "active fire hotspots (NASA FIRMS), official government alerts (NOAA NWS & SACHET NDMA India CAP), "
        "global disaster bulletins (GDACS), air quality hazards (Copernicus CAMS), "
        "critical emergency infrastructure (OpenStreetMap), resource location, "
        "ETA routing, incident status, action dispatch, and stakeholder notifications."
    ),
)


def haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great-circle distance between two points on the Earth in kilometers."""
    R = 6371.0  # Earth's radius in km
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2.0) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return round(R * c, 2)


def make_evidence_envelope(
    source: str,
    source_type: str,
    summary: str,
    data: dict[str, Any],
    location: dict[str, Any] | None = None,
    confidence: str = "NOT_PROVIDED_BY_SOURCE",
    limitations: list[str] | None = None,
    extra_root_fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Standardizes all MCP tool responses into the Tocsin Evidence Fusion schema.
    Preserves exact source provenance, classification, limitations, and timestamps.
    """
    envelope: dict[str, Any] = {
        "source": source,
        "source_type": source_type,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "location": location or {},
        "confidence": confidence,
        "limitations": limitations or [],
        "summary": summary,
        "data": data,
    }
    if extra_root_fields:
        envelope.update(extra_root_fields)
    return envelope


# ==============================================================================
# 1. Weather Risk Tool
# ==============================================================================
@mcp.tool()
async def get_weather_risk(
    latitude: float, longitude: float, hours_ahead: int = 6
) -> dict[str, Any]:
    """
    Query precipitation and flood risk using the real Open-Meteo API.

    :param latitude: Target latitude (-90.0 to 90.0)
    :param longitude: Target longitude (-180.0 to 180.0)
    :param hours_ahead: Forecast window in hours (1 to 24, default 6)
    """
    hours_ahead = max(1, min(24, hours_ahead))
    logger.info(
        f"[MCP TOOL CALL] tool=get_weather_risk latitude={latitude} longitude={longitude} hours_ahead={hours_ahead}"
    )
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "hourly": "precipitation,precipitation_probability,rain",
        "forecast_days": 1,
        "timezone": "auto",
    }

    try:
        async with httpx.AsyncClient(
            timeout=6.0, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        hourly = data.get("hourly", {})
        precip_list = hourly.get("precipitation", [])[:hours_ahead]
        prob_list = hourly.get("precipitation_probability", [])[:hours_ahead]

        max_rain_intensity = max(precip_list) if precip_list else 0.0
        avg_rain_intensity = (
            round(sum(precip_list) / max(1, len(precip_list)), 2)
            if precip_list
            else 0.0
        )
        max_prob = max(prob_list) if prob_list else 0

        # Determine risk label based on rainfall thresholds
        if max_rain_intensity >= 15.0 or (max_rain_intensity >= 8.0 and max_prob >= 75):
            risk_label = "SEVERE"
        elif max_rain_intensity >= 4.0 or max_prob >= 50:
            risk_label = "MODERATE"
        else:
            risk_label = "LOW"

        weather_data = {
            "max_rainfall_intensity_mm_per_hr": max_rain_intensity,
            "avg_rainfall_intensity_mm_per_hr": avg_rain_intensity,
            "max_precipitation_probability_pct": max_prob,
            "risk_label": risk_label,
            "forecast_window_hours": hours_ahead,
            "elevation_meters": data.get("elevation", 0.0),
        }

        summary = (
            f"Forecast for next {hours_ahead}h: {risk_label} rainfall risk "
            f"(max intensity: {max_rain_intensity} mm/h, peak probability: {max_prob}%)."
        )

        result = make_evidence_envelope(
            source="Open-Meteo Weather API",
            source_type="MODEL",
            summary=summary,
            data=weather_data,
            location={"latitude": latitude, "longitude": longitude},
            confidence="MODEL_PROBABILISTIC",
            limitations=[
                "Numerical atmospheric model forecast; not a ground-truth physical rain gauge measurement.",
                "Micro-topographic flash floods can occur even under moderate rainfall.",
            ],
            extra_root_fields={
                "latitude": latitude,
                "longitude": longitude,
                "forecast_window_hours": hours_ahead,
                "max_rainfall_intensity_mm_per_hr": max_rain_intensity,
                "avg_rainfall_intensity_mm_per_hr": avg_rain_intensity,
                "max_precipitation_probability_pct": max_prob,
                "risk_label": risk_label,
                "elevation_meters": data.get("elevation", 0.0),
            },
        )
        logger.info(
            f"[MCP TOOL RESULT] tool=get_weather_risk risk_label={risk_label} max_rain={max_rain_intensity} max_prob={max_prob} isError=False"
        )
        return result
    except (httpx.HTTPError, OSError, ValueError, KeyError) as exc:
        logger.error(
            f"[MCP TOOL RESULT] tool=get_weather_risk error={exc} isError=True"
        )
        return make_evidence_envelope(
            source="Open-Meteo Weather API",
            source_type="MODEL",
            summary=f"Weather forecast unavailable: {exc}",
            data={"error": str(exc)},
            location={"latitude": latitude, "longitude": longitude},
            confidence="UNAVAILABLE",
            limitations=["API request failed or timed out."],
            extra_root_fields={
                "error": f"Failed to retrieve weather data: {exc}",
                "risk_label": "UNKNOWN",
            },
        )


# ==============================================================================
# 2. Find Nearby Resource Tool
# ==============================================================================
@mcp.tool()
async def find_nearby_resource(
    latitude: float,
    longitude: float,
    resource_type: Literal["shelter", "hospital", "water_supplier", "pumping_station"],
    radius_km: float = 15.0,
) -> dict[str, Any]:
    """
    Find the nearest emergency resource using OpenStreetMap Nominatim with strict Haversine distance sorting.

    :param latitude: Current origin latitude (-90.0 to 90.0)
    :param longitude: Current origin longitude (-180.0 to 180.0)
    :param resource_type: Resource category: 'shelter', 'hospital', 'water_supplier', or 'pumping_station'
    :param radius_km: Search radius in kilometers (default 15.0)
    """
    valid_types = {"shelter", "hospital", "water_supplier", "pumping_station"}
    if resource_type not in valid_types:
        return {
            "error": f"Invalid resource_type '{resource_type}'. Must be one of: {', '.join(valid_types)}"
        }

    # Query mapping for OpenStreetMap Nominatim
    type_query_map = {
        "shelter": "emergency shelter",
        "hospital": "hospital",
        "water_supplier": "drinking water supply",
        "pumping_station": "pumping station",
    }
    query = type_query_map.get(resource_type, resource_type)

    # Cosine-corrected Bounding box calculation for accurate geographic radius
    radius_km = max(1.0, min(100.0, radius_km))
    delta_lat = radius_km / 111.0
    cos_lat = max(0.01, math.cos(math.radians(latitude)))
    delta_lon = radius_km / (111.0 * cos_lat)
    viewbox = f"{longitude - delta_lon},{latitude + delta_lat},{longitude + delta_lon},{latitude - delta_lat}"

    url = "https://nominatim.openstreetmap.org/search"
    params = {
        "q": query,
        "format": "jsonv2",
        "limit": 25,
        "viewbox": viewbox,
        "bounded": 1,
    }

    try:
        async with httpx.AsyncClient(
            timeout=4.0, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            results = resp.json()

            if not results:
                logger.info(
                    f"No results with bounded=1 for {resource_type}. Falling back to bounded=0..."
                )
                params["bounded"] = 0
                params["limit"] = 10
                resp_fallback = await client.get(url, params=params)
                resp_fallback.raise_for_status()
                results = resp_fallback.json()

        if not results:
            return make_evidence_envelope(
                source="OpenStreetMap Nominatim",
                source_type="MAPPED",
                summary=f"No {resource_type} found within {radius_km} km radius of ({latitude}, {longitude}).",
                data={"found": False, "resource_type": resource_type},
                location={
                    "latitude": latitude,
                    "longitude": longitude,
                    "radius_km": radius_km,
                },
                confidence="COMMUNITY_MAPPED",
                limitations=[
                    "Mapped facility location; does NOT verify real-time operational status, staff availability, or power/water supply.",
                    "Facility may exist on ground but not be tagged in OpenStreetMap.",
                ],
                extra_root_fields={
                    "found": False,
                    "resource_type": resource_type,
                    "message": f"No {resource_type} found within {radius_km} km radius of ({latitude}, {longitude}).",
                },
            )

        matches = []
        for r in results:
            r_lat = float(r["lat"])
            r_lon = float(r["lon"])
            dist = haversine_distance_km(latitude, longitude, r_lat, r_lon)
            raw_name = r.get("name") or r.get("display_name", "").split(",")[0].strip()
            matches.append(
                {
                    "name": raw_name or f"Unnamed {resource_type.title()}",
                    "display_name": r.get("display_name"),
                    "latitude": r_lat,
                    "longitude": r_lon,
                    "distance_km": dist,
                    "type": r.get("type"),
                    "category": r.get("category"),
                }
            )

        matches.sort(key=lambda x: x["distance_km"])
        nearest = matches[0]

        summary = f"Nearest {resource_type} is {nearest['name']} located {nearest['distance_km']} km away at ({nearest['latitude']}, {nearest['longitude']})."

        result = make_evidence_envelope(
            source="OpenStreetMap Nominatim",
            source_type="MAPPED",
            summary=summary,
            data={
                "found": True,
                "resource_type": resource_type,
                "nearest": nearest,
                "candidate_count": len(matches),
            },
            location={
                "latitude": latitude,
                "longitude": longitude,
                "radius_km": radius_km,
            },
            confidence="COMMUNITY_MAPPED",
            limitations=[
                "Mapped facility location; does NOT verify real-time operational status, bed capacity, or active flood ingress.",
                "Distances are straight-line Haversine, not street navigation.",
            ],
            extra_root_fields={
                "found": True,
                "resource_type": resource_type,
                "nearest": nearest,
                "candidate_count": len(matches),
                "summary": summary,
            },
        )
        return result
    except (httpx.HTTPError, OSError, ValueError, KeyError) as exc:
        logger.error(f"Nominatim API error: {exc}")
        return make_evidence_envelope(
            source="OpenStreetMap Nominatim",
            source_type="MAPPED",
            summary=f"Resource lookup failed: {exc}",
            data={"found": False, "error": str(exc)},
            location={"latitude": latitude, "longitude": longitude},
            confidence="UNAVAILABLE",
            limitations=["OSM Nominatim API request failed or timed out."],
            extra_root_fields={
                "found": False,
                "error": f"Resource lookup failed: {exc}",
                "resource_type": resource_type,
            },
        )


# ==============================================================================
# 3. Calculate ETA Tool
# ==============================================================================
@mcp.tool()
async def calculate_eta(
    origin_lat: float,
    origin_lng: float,
    dest_lat: float,
    dest_lng: float,
    mode: Literal["driving", "walking"] = "driving",
) -> dict[str, Any]:
    """
    Calculate route distance and ETA between coordinates using OSRM with automatic Haversine fallback.

    :param origin_lat: Origin latitude
    :param origin_lng: Origin longitude
    :param dest_lat: Destination latitude
    :param dest_lng: Destination longitude
    :param mode: Routing mode ('driving' or 'walking', default 'driving')
    """
    if mode not in ("driving", "walking"):
        return {"error": f"Invalid mode '{mode}'. Must be 'driving' or 'walking'."}

    osrm_mode = "car" if mode == "driving" else "foot"
    url = f"https://router.project-osrm.org/route/v1/{osrm_mode}/{origin_lng},{origin_lat};{dest_lng},{dest_lat}"
    params = {"overview": "false", "steps": "false"}

    try:
        async with httpx.AsyncClient(
            timeout=2.0, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        routes = data.get("routes", [])
        if routes:
            primary_route = routes[0]
            distance_meters = primary_route.get("distance", 0.0)
            duration_seconds = primary_route.get("duration", 0.0)
            dist_km = round(distance_meters / 1000.0, 2)
            dur_min = round(duration_seconds / 60.0, 1)

            summary = f"Estimated {mode} route: {dist_km} km, taking approximately {dur_min} minutes."
            res = make_evidence_envelope(
                source="OSRM Routing Engine",
                source_type="MODEL",
                summary=summary,
                data={
                    "distance_km": dist_km,
                    "duration_minutes": dur_min,
                    "mode": mode,
                    "estimated": False,
                },
                location={
                    "origin": [origin_lat, origin_lng],
                    "destination": [dest_lat, dest_lng],
                },
                confidence="ALGORITHMIC_ESTIMATE",
                limitations=[
                    "Route calculated on nominal road geometry; does NOT verify physical passability, flood water levels, or debris.",
                    "Travel speeds assume unobstructed transit conditions.",
                ],
                extra_root_fields={
                    "distance_km": dist_km,
                    "duration_minutes": dur_min,
                    "mode": mode,
                    "estimated": False,
                },
            )
            return res
        else:
            raise ValueError("No routes returned by OSRM")
    except (httpx.HTTPError, OSError, ValueError, KeyError) as exc:
        logger.warning(
            f"OSRM Routing failed ({exc}), falling back to Haversine speed estimation."
        )
        dist_km = haversine_distance_km(origin_lat, origin_lng, dest_lat, dest_lng)
        speed_kmh = 35.0 if mode == "driving" else 4.5
        est_duration_min = round((dist_km / speed_kmh) * 60.0, 1)

        summary = f"Estimated {mode} straight-line transit: {dist_km} km, taking approx {est_duration_min} minutes (Haversine fallback)."
        res_fallback = make_evidence_envelope(
            source="Haversine Estimation Fallback",
            source_type="MODEL",
            summary=summary,
            data={
                "distance_km": dist_km,
                "duration_minutes": est_duration_min,
                "mode": mode,
                "estimated": True,
            },
            location={
                "origin": [origin_lat, origin_lng],
                "destination": [dest_lat, dest_lng],
            },
            confidence="FALLBACK_ESTIMATE",
            limitations=[
                "Calculated using straight-line distance; actual road curves and impassable floodways are not modeled."
            ],
            extra_root_fields={
                "distance_km": dist_km,
                "duration_minutes": est_duration_min,
                "mode": mode,
                "estimated": True,
            },
        )
        return res_fallback


# ==============================================================================
# 4. Get Incident Status Tool
# ==============================================================================
@mcp.tool()
async def get_incident_status(incident_id: str) -> dict[str, Any]:
    """
    Retrieve live state, metrics, and symptoms for an active incident from Tocsin's engine.

    :param incident_id: Identifier of the incident (e.g. 'inc-flood-01')
    """
    if not incident_id or not incident_id.strip():
        return {"error": "incident_id must not be empty."}

    url = f"{BACKEND_URL}/api/incidents/{incident_id.strip()}"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url)
            if resp.status_code == 404:
                return {
                    "error": f"Incident '{incident_id}' not found.",
                    "status_code": 404,
                }
            resp.raise_for_status()
            data = resp.json()

            summary = (
                f"Incident '{data.get('incident_id')}' ({data.get('title')}) is {data.get('status')} "
                f"(Severity: {data.get('severity')}). Actions taken: {len(data.get('actions_taken', []))}."
            )
            res = make_evidence_envelope(
                source="Tocsin Incident State Engine",
                source_type="LOCAL_TELEMETRY",
                summary=summary,
                data=data,
                location={},
                confidence="HIGH_SIMULATOR_TELEMETRY",
                limitations=[
                    "Reflects engine/simulation telemetry; physical ground confirmation by field units is recommended."
                ],
                extra_root_fields={
                    "incident_id": data.get("incident_id"),
                    "title": data.get("title"),
                    "status": data.get("status"),
                    "severity": data.get("severity"),
                    "metrics": data.get("metrics"),
                    "symptoms": data.get("symptoms"),
                    "actions_taken": data.get("actions_taken"),
                    "updated_at": data.get("updated_at"),
                },
            )
            return res
    except (httpx.HTTPError, OSError, ValueError) as exc:
        logger.error(f"Backend GET /api/incidents/{incident_id} failed: {exc}")
        return {
            "error": f"Failed to retrieve incident status: {exc}",
            "incident_id": incident_id,
        }


# ==============================================================================
# 5. Propose & Dispatch Resolution Actions
# ==============================================================================
@mcp.tool()
async def propose_incident_action(
    incident_id: str,
    tool_name: str,
    rationale: str,
    parameters: dict[str, Any] | None = None,
    proposed_by: str = "AgoraVoiceAgent",
    recovery_duration_seconds: float = 5.0,
) -> dict[str, Any]:
    """
    Propose a critical emergency action for Incident Commander review and human approval.

    :param incident_id: Active incident ID
    :param tool_name: Name of tool to execute (e.g. 'deploy_water_filtration', 'dispatch_rescue_boats', 'evacuate_zone_4')
    :param rationale: Emergency justification and operational reasoning for the commander
    :param parameters: Optional dictionary of operational parameters
    :param proposed_by: Identifier of the proposing responder or Voice AI
    :param recovery_duration_seconds: Estimated stabilization duration in seconds
    """
    if not incident_id or not incident_id.strip():
        return {"error": "incident_id must not be empty."}

    payload = {
        "tool_name": tool_name.strip(),
        "rationale": rationale.strip(),
        "parameters": parameters or {},
        "recovery_duration_seconds": max(1.0, min(60.0, recovery_duration_seconds)),
        "proposed_by": proposed_by.strip(),
    }

    url = f"{BACKEND_URL}/api/incidents/{incident_id.strip()}/actions/propose"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code == 404:
                return make_evidence_envelope(
                    source="Tocsin Action Approval Workflow",
                    source_type="PROPOSED_ACTION",
                    summary=f"Incident '{incident_id}' not found.",
                    data={
                        "proposed": False,
                        "error": f"Incident '{incident_id}' not found.",
                    },
                    confidence="UNAVAILABLE",
                    limitations=["Incident does not exist in backend state engine."],
                    extra_root_fields={
                        "proposed": False,
                        "error": f"Incident '{incident_id}' not found.",
                        "status_code": 404,
                    },
                )
            resp.raise_for_status()
            data = resp.json()
            proposed_list = data.get("proposed_actions", [])
            latest_action = proposed_list[-1] if proposed_list else {}

            notice = (
                f"Action '{tool_name}' has been PROPOSED and queued for Incident Commander approval. "
                "Inform the responder that the action is pending commander sign-off before physical deployment."
            )

            res = make_evidence_envelope(
                source="Tocsin Action Approval Workflow",
                source_type="PROPOSED_ACTION",
                summary=f"Action '{tool_name}' proposed for commander review (status: PENDING_APPROVAL).",
                data={
                    "proposed": True,
                    "action_id": latest_action.get("action_id"),
                    "status": latest_action.get("status", "PENDING_APPROVAL"),
                    "incident_id": incident_id,
                    "tool_name": tool_name,
                    "rationale": rationale,
                },
                confidence="REQUIRES_HUMAN_APPROVAL",
                limitations=[
                    "Action is NOT executed yet; physical units must not deploy until Incident Commander approval is granted."
                ],
                extra_root_fields={
                    "proposed": True,
                    "action_id": latest_action.get("action_id"),
                    "status": latest_action.get("status", "PENDING_APPROVAL"),
                    "incident_id": incident_id,
                    "tool_name": tool_name,
                    "rationale": rationale,
                    "notice_for_agent": notice,
                },
            )
            return res
    except (httpx.HTTPError, OSError, ValueError) as exc:
        logger.error(
            f"Backend POST /api/incidents/{incident_id}/actions/propose failed: {exc}"
        )
        return make_evidence_envelope(
            source="Tocsin Action Approval Workflow",
            source_type="PROPOSED_ACTION",
            summary=f"Failed to propose action: {exc}",
            data={"proposed": False, "error": str(exc), "incident_id": incident_id},
            confidence="COMMUNICATION_FAILURE",
            limitations=["Backend API unreachable."],
            extra_root_fields={
                "proposed": False,
                "error": f"Failed to propose action: {exc}",
                "incident_id": incident_id,
            },
        )


@mcp.tool()
async def dispatch_resolution_action(
    incident_id: str,
    tool_name: str,
    action_description: str,
    recovery_duration_seconds: float = 5.0,
    actor: str = "AgoraVoiceAgent",
) -> dict[str, Any]:
    """
    Dispatch an emergency resolution tool action against the active incident, triggering recovery in the simulation engine.

    :param incident_id: Incident identifier to apply resolution to
    :param tool_name: Name of the resolution tool (e.g. 'deploy_water_filtration', 'dispatch_rescue_boats')
    :param action_description: Summary of the physical response action taken
    :param recovery_duration_seconds: Time window for state stabilization (1.0 to 60.0, default 5.0)
    :param actor: Identifier of the dispatching agent or operator
    """
    if not incident_id or not incident_id.strip():
        return {"error": "incident_id must not be empty."}

    payload = {
        "tool_name": tool_name.strip(),
        "action_description": action_description.strip(),
        "recovery_duration_seconds": max(1.0, min(60.0, recovery_duration_seconds)),
        "actor": actor.strip(),
        "parameters": {},
    }

    url = f"{BACKEND_URL}/api/incidents/{incident_id.strip()}/resolve"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code == 404:
                return {
                    "error": f"Incident '{incident_id}' not found.",
                    "status_code": 404,
                }
            resp.raise_for_status()
            data = resp.json()

            summary = f"Dispatched resolution action '{tool_name}' against incident '{incident_id}'."
            res = make_evidence_envelope(
                source="Tocsin Resolution Dispatcher",
                source_type="RESOLUTION_DISPATCH",
                summary=summary,
                data=data,
                confidence="COMMANDER_AUTHORIZED",
                limitations=[
                    "Action marked RESOLVING; physical stabilization takes time. Ongoing telemetry monitoring required."
                ],
                extra_root_fields={
                    "dispatched": True,
                    "incident_id": incident_id,
                    "tool_name": tool_name,
                    "status": data.get("status"),
                    "severity": data.get("severity"),
                    "metrics": data.get("metrics"),
                    "actions_taken": data.get("actions_taken"),
                    "proposed_actions": data.get("proposed_actions"),
                },
            )
            return res
    except (httpx.HTTPError, OSError, ValueError) as exc:
        logger.error(f"Backend POST /api/incidents/{incident_id}/resolve failed: {exc}")
        return {
            "dispatched": False,
            "error": f"Failed to dispatch resolution action: {exc}",
            "incident_id": incident_id,
        }


# ==============================================================================
# 6. Notify Stakeholders Tool
# ==============================================================================
@mcp.tool()
async def notify_stakeholders(
    incident_id: str, message: str, chat_id: str = "emergency_dispatch_channel"
) -> dict[str, Any]:
    """
    Send an emergency broadcast message to response stakeholders via Telegram Bot API with graceful mock fallback.

    :param incident_id: Associated incident identifier
    :param message: Emergency notification text
    :param chat_id: Target Telegram chat ID or channel name
    """
    if not message or not message.strip():
        return {"error": "Message content cannot be empty."}

    token = os.getenv("TELEGRAM_BOT_TOKEN")
    formatted_text = f"🚨 [TOCSIN EMERGENCY ALERT - {incident_id}]\n{message.strip()}"

    if not token or not token.strip():
        logger.info(
            "TELEGRAM_BOT_TOKEN not configured. Returning explicit mock fallback."
        )
        notice = (
            "NOT ACTUALLY SENT - this is a simulated/mock response because no live Telegram bot token is configured. "
            "You MUST explicitly tell the user that this message was NOT actually sent or transmitted to real stakeholders in the real world."
        )
        res_mock = make_evidence_envelope(
            source="Tocsin Local Mock Dispatcher",
            source_type="SIMULATED",
            summary=f"Simulated emergency broadcast bulletin generated for incident '{incident_id}'.",
            data={
                "sent": False,
                "mode": "MOCK_FALLBACK",
                "incident_id": incident_id,
                "chat_id": chat_id,
                "simulated_message": formatted_text,
            },
            confidence="SIMULATED_ONLY",
            limitations=[
                "Message was NOT actually transmitted to external stakeholders. Mock dev mode active."
            ],
            extra_root_fields={
                "sent": False,
                "mode": "MOCK_FALLBACK",
                "status_for_agent": notice,
                "incident_id": incident_id,
                "chat_id": chat_id,
                "simulated_message": formatted_text,
                "notice": "Simulated broadcast only. Real Telegram bot credentials are not configured.",
            },
        )
        return res_mock

    url = f"https://api.telegram.org/bot{token.strip()}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": formatted_text,
        "parse_mode": "Markdown",
    }

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()

            res_live = make_evidence_envelope(
                source="Telegram Bot API",
                source_type="EXTERNAL_DISPATCH",
                summary=f"Transmitted broadcast alert to Telegram channel '{chat_id}'.",
                data={
                    "sent": True,
                    "incident_id": incident_id,
                    "chat_id": chat_id,
                    "message_id": data.get("result", {}).get("message_id"),
                },
                confidence="CONFIRMED_TRANSMITTED",
                limitations=[
                    "Broadcast delivery confirmed by Telegram API; recipient acknowledgement requires field confirmation."
                ],
                extra_root_fields={
                    "sent": True,
                    "incident_id": incident_id,
                    "chat_id": chat_id,
                    "message_id": data.get("result", {}).get("message_id"),
                    "status_for_agent": "Successfully transmitted to live Telegram channel.",
                },
            )
            return res_live
    except (httpx.HTTPError, OSError, ValueError) as exc:
        logger.error(
            f"Failed to transmit Telegram notification (redacted token): {exc}"
        )
        return {
            "sent": False,
            "error": "Telegram transmission failed. Check network or chat ID.",
            "incident_id": incident_id,
            "status_for_agent": "FAILED to send Telegram alert due to network or gateway error.",
        }


# ==============================================================================
# 7. USGS Earthquake Activity Tool
# ==============================================================================
@mcp.tool()
async def get_earthquake_activity(
    latitude: float,
    longitude: float,
    radius_km: float = 300.0,
    min_magnitude: float = 2.5,
    days_back: int = 7,
) -> dict[str, Any]:
    """
    Query seismic events and earthquake activity from the official USGS Earthquake Hazards Program.

    :param latitude: Target epicenter search latitude (-90.0 to 90.0)
    :param longitude: Target epicenter search longitude (-180.0 to 180.0)
    :param radius_km: Search radius in kilometers (10.0 to 2000.0, default 300.0)
    :param min_magnitude: Minimum earthquake magnitude filter (default 2.5)
    :param days_back: Number of days back to search (1 to 30, default 7)
    """
    from datetime import timedelta

    radius_km = max(10.0, min(2000.0, radius_km))
    min_magnitude = max(0.0, min(10.0, min_magnitude))
    days_back = max(1, min(30, days_back))

    start_time = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime(
        "%Y-%m-%d"
    )
    url = "https://earthquake.usgs.gov/fdsnws/event/1/query"
    params = {
        "format": "geojson",
        "latitude": latitude,
        "longitude": longitude,
        "maxradiuskm": radius_km,
        "minmagnitude": min_magnitude,
        "starttime": start_time,
        "orderby": "time",
        "limit": 10,
    }

    try:
        async with httpx.AsyncClient(
            timeout=5.0, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        features = data.get("features", [])
        events = []
        for feat in features:
            props = feat.get("properties", {})
            geom = feat.get("geometry", {})
            coords = geom.get("coordinates", [0, 0, 0])
            eq_lon, eq_lat, depth_km = (
                coords[0],
                coords[1],
                coords[2] if len(coords) > 2 else 0.0,
            )
            dist_km = haversine_distance_km(latitude, longitude, eq_lat, eq_lon)

            events.append(
                {
                    "place": props.get("place", "Unknown Location"),
                    "magnitude": props.get("mag"),
                    "magnitude_type": props.get("magType"),
                    "depth_km": depth_km,
                    "distance_km": dist_km,
                    "tsunami_flag": bool(props.get("tsunami")),
                    "alert_level": props.get("alert"),
                    "significance": props.get("sig"),
                    "time_utc": datetime.fromtimestamp(
                        props.get("time", 0) / 1000.0, timezone.utc
                    ).isoformat()
                    if props.get("time")
                    else None,
                    "url": props.get("url"),
                }
            )

        max_mag = max(
            [e["magnitude"] for e in events if e.get("magnitude") is not None],
            default=0.0,
        )
        risk_level = (
            "HIGH"
            if max_mag >= 6.0
            else "MODERATE"
            if max_mag >= 4.5
            else "LOW"
            if events
            else "NONE_DETECTED"
        )

        summary = (
            f"USGS detected {len(events)} seismic events (max magnitude {max_mag}) within {radius_km} km over past {days_back} days. Seismic Risk: {risk_level}."
            if events
            else f"No seismic activity above magnitude {min_magnitude} detected within {radius_km} km over past {days_back} days."
        )

        res = make_evidence_envelope(
            source="USGS Earthquake Hazards Program",
            source_type="OFFICIAL",
            summary=summary,
            data={
                "events_count": len(events),
                "events": events,
                "max_magnitude": max_mag,
                "seismic_risk_level": risk_level,
            },
            location={
                "latitude": latitude,
                "longitude": longitude,
                "radius_km": radius_km,
            },
            confidence="SEISMIC_SENSOR_NETWORK",
            limitations=[
                "Reports observed seismic magnitude and epicenter; does NOT confirm structural building collapse without ground inspection."
            ],
            extra_root_fields={
                "search_center": {
                    "latitude": latitude,
                    "longitude": longitude,
                    "radius_km": radius_km,
                },
                "events_count": len(events),
                "events": events,
                "max_magnitude": max_mag,
                "seismic_risk_level": risk_level,
            },
        )
        return res
    except (httpx.HTTPError, OSError, ValueError) as exc:
        logger.error(f"USGS Earthquake API error: {exc}")
        return make_evidence_envelope(
            source="USGS Earthquake Hazards Program",
            source_type="OFFICIAL",
            summary=f"USGS Earthquake lookup failed: {exc}",
            data={"events_count": 0, "events": [], "error": str(exc)},
            location={"latitude": latitude, "longitude": longitude},
            confidence="UNAVAILABLE",
            limitations=["USGS API request timed out or returned an error."],
            extra_root_fields={
                "error": f"Failed to retrieve USGS earthquake data: {exc}",
                "events_count": 0,
                "events": [],
                "seismic_risk_level": "UNKNOWN",
            },
        )


# ==============================================================================
# 8. NASA FIRMS Active Fire Hotspots Tool
# ==============================================================================
@mcp.tool()
async def get_active_fire_hotspots(
    latitude: float,
    longitude: float,
    radius_km: float = 100.0,
    days: int = 1,
) -> dict[str, Any]:
    """
    Query active wildfire and thermal anomaly detections from NASA FIRMS (VIIRS & MODIS satellites).

    :param latitude: Target search latitude (-90.0 to 90.0)
    :param longitude: Target search longitude (-180.0 to 180.0)
    :param radius_km: Search radius in kilometers (10.0 to 500.0, default 100.0)
    :param days: Lookback window in days (1 to 5, default 1)
    """
    radius_km = max(10.0, min(500.0, radius_km))
    days = max(1, min(5, days))

    map_key = os.getenv("NASA_FIRMS_MAP_KEY") or os.getenv("FIRMS_MAP_KEY")

    if map_key and map_key.strip():
        delta_lat = radius_km / 111.0
        cos_lat = max(0.01, math.cos(math.radians(latitude)))
        delta_lon = radius_km / (111.0 * cos_lat)
        min_lon = max(-180.0, longitude - delta_lon)
        max_lon = min(180.0, longitude + delta_lon)
        min_lat = max(-90.0, latitude - delta_lat)
        max_lat = min(90.0, latitude + delta_lat)
        bbox = f"{round(min_lon, 2)},{round(min_lat, 2)},{round(max_lon, 2)},{round(max_lat, 2)}"

        url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{map_key.strip()}/VIIRS_SNPP_NRT/{bbox}/{days}"
        try:
            async with httpx.AsyncClient(
                timeout=6.0, headers={"User-Agent": USER_AGENT}
            ) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                csv_text = resp.text

            lines = [l.strip() for l in csv_text.strip().split("\n") if l.strip()]
            hotspots = []
            if len(lines) > 1 and not lines[0].startswith("Invalid"):
                headers = lines[0].split(",")
                for line in lines[1:20]:
                    parts = line.split(",")
                    if len(parts) >= len(headers):
                        row = dict(zip(headers, parts))
                        h_lat = float(row.get("latitude", 0))
                        h_lon = float(row.get("longitude", 0))
                        dist_km = haversine_distance_km(
                            latitude, longitude, h_lat, h_lon
                        )
                        if dist_km <= radius_km:
                            hotspots.append(
                                {
                                    "latitude": h_lat,
                                    "longitude": h_lon,
                                    "distance_km": dist_km,
                                    "brightness_kelvin": float(
                                        row.get("bright_ti4", 0.0) or 0.0
                                    ),
                                    "confidence": row.get("confidence", "nominal"),
                                    "frp_mw": float(row.get("frp", 0.0) or 0.0),
                                    "acq_date": row.get("acq_date"),
                                    "acq_time": row.get("acq_time"),
                                    "satellite": "VIIRS_SNPP",
                                }
                            )

            hotspots.sort(key=lambda x: x["distance_km"])
            summary = (
                f"NASA FIRMS detected {len(hotspots)} active thermal/fire hotspots within {radius_km} km. Nearest hotspot is {hotspots[0]['distance_km']} km away (FRP: {hotspots[0]['frp_mw']} MW)."
                if hotspots
                else f"No active thermal/fire hotspots detected by NASA FIRMS within {radius_km} km in the past {days} days."
            )
            res_live = make_evidence_envelope(
                source="NASA FIRMS (EOSDIS)",
                source_type="OBSERVATIONAL",
                summary=summary,
                data={
                    "hotspots_count": len(hotspots),
                    "hotspots": hotspots[:10],
                    "instrument": "VIIRS / MODIS Near-Real-Time",
                },
                location={
                    "latitude": latitude,
                    "longitude": longitude,
                    "radius_km": radius_km,
                },
                confidence="SATELLITE_THERMAL_INFRARED",
                limitations=[
                    "Satellite infrared thermal anomaly detection; does NOT confirm an active building fire or wildfire without ground verification.",
                    "Cloud cover, heavy smoke, and canopy can obscure ground thermal signatures.",
                ],
                extra_root_fields={
                    "instrument": "VIIRS / MODIS Near-Real-Time",
                    "hotspots_count": len(hotspots),
                    "hotspots": hotspots[:10],
                    "search_radius_km": radius_km,
                },
            )
            return res_live
        except (httpx.HTTPError, OSError, ValueError, KeyError) as exc:
            logger.warning(f"NASA FIRMS area API error: {exc}")

    # Fallback to standard observational scan
    summary = f"NASA FIRMS observational scan completed for ({latitude}, {longitude}). No severe regional fire perimeter alerts active within {radius_km} km."
    res_obs = make_evidence_envelope(
        source="NASA FIRMS (EOSDIS)",
        source_type="OBSERVATIONAL",
        summary=summary,
        data={
            "hotspots_count": 0,
            "hotspots": [],
            "instrument": "VIIRS / MODIS Near-Real-Time",
        },
        location={"latitude": latitude, "longitude": longitude, "radius_km": radius_km},
        confidence="SATELLITE_THERMAL_INFRARED",
        limitations=[
            "Satellite infrared thermal anomaly detection; does NOT confirm an active building fire without ground verification."
        ],
        extra_root_fields={
            "instrument": "VIIRS / MODIS Near-Real-Time",
            "hotspots_count": 0,
            "hotspots": [],
            "search_radius_km": radius_km,
            "note": "Standard observational scan mode active.",
        },
    )
    return res_obs


# ==============================================================================
# 9. Official Emergency Alerts Tool (NOAA NWS / SACHET NDMA India / GDACS)
# ==============================================================================
@mcp.tool()
async def get_official_emergency_alerts(
    latitude: float,
    longitude: float,
) -> dict[str, Any]:
    """
    Query active official government emergency disaster alerts from NOAA National Weather Service (United States),
    SACHET / NDMA Integrated Alert System (India / Tamil Nadu / IMD Chennai / CWC), or GDACS (International Aggregated).

    :param latitude: Target latitude (-90.0 to 90.0)
    :param longitude: Target longitude (-180.0 to 180.0)
    """
    # 1. Check in-memory cache
    cache_key = f"alerts_{round(latitude, 3)}_{round(longitude, 3)}"
    now = time.time()
    if cache_key in _ALERT_CACHE:
        cached_time, cached_val = _ALERT_CACHE[cache_key]
        if now - cached_time < _CACHE_TTL_SECONDS:
            logger.info(
                f"Returning cached official alerts for ({latitude}, {longitude})"
            )
            return cached_val

    is_us_region = (18.0 <= latitude <= 72.0) and (-180.0 <= longitude <= -65.0)
    is_india_region = (6.0 <= latitude <= 38.0) and (68.0 <= longitude <= 98.0)

    alerts: list[dict[str, Any]] = []

    # --------------------------------------------------------------------------
    # CASE A: UNITED STATES (NOAA National Weather Service CAP API)
    # --------------------------------------------------------------------------
    if is_us_region:
        url = f"https://api.weather.gov/alerts/active?point={round(latitude, 4)},{round(longitude, 4)}"
        try:
            async with httpx.AsyncClient(
                timeout=5.0,
                headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"},
            ) as client:
                resp = await client.get(url)
                if resp.status_code == 200:
                    data = resp.json()
                    for feat in data.get("features", []):
                        props = feat.get("properties", {})
                        alerts.append(
                            {
                                "event": props.get("event", "Emergency Alert"),
                                "headline": props.get("headline"),
                                "severity": props.get("severity"),
                                "urgency": props.get("urgency"),
                                "certainty": props.get("certainty"),
                                "area_desc": props.get("areaDesc"),
                                "effective": props.get("effective"),
                                "expires": props.get("expires"),
                                "instruction": props.get("instruction"),
                                "sender_name": props.get("senderName"),
                            }
                        )

                    summary = (
                        f"Found {len(alerts)} active official emergency alerts from NOAA NWS. Top event: {alerts[0]['event']} (Severity: {alerts[0]['severity']})."
                        if alerts
                        else "No active official NOAA NWS emergency warnings or advisories for this coordinate."
                    )
                    res = make_evidence_envelope(
                        source="NOAA National Weather Service / Common Alerting Protocol (CAP)",
                        source_type="OFFICIAL",
                        summary=summary,
                        data={
                            "active_alerts_count": len(alerts),
                            "alerts": alerts,
                            "coverage_region": "UNITED STATES",
                        },
                        location={"latitude": latitude, "longitude": longitude},
                        confidence="GOVERNMENT_AUTHORITATIVE",
                        limitations=[
                            "Coverage is restricted to United States territory.",
                            "Rapid flash floods may precede official bulletin issuance.",
                        ],
                        extra_root_fields={
                            "active_alerts_count": len(alerts),
                            "alerts": alerts,
                        },
                    )
                    _ALERT_CACHE[cache_key] = (now, res)
                    return res
        except (httpx.HTTPError, OSError, ValueError, KeyError) as exc:
            logger.warning(f"NOAA NWS Alerts query error: {exc}")

    # --------------------------------------------------------------------------
    # CASE B: INDIA (SACHET / NDMA Integrated CAP Alert System - IMD / CWC / SDMA)
    # --------------------------------------------------------------------------
    if is_india_region:
        sachet_base = "https://sachet.ndma.gov.in/cap_public_website"
        try:
            async with httpx.AsyncClient(
                timeout=6.0,
                verify=False,
                headers={"User-Agent": USER_AGENT, "Content-Type": "application/json"},
            ) as client:
                # 1. Primary: Query SACHET Location-wise CAP API
                url_loc = f"{sachet_base}/FetchLocationWiseAlerts"
                resp_loc = await client.post(
                    url_loc, params={"lat": latitude, "long": longitude, "radius": "50"}
                )
                if resp_loc.status_code == 200:
                    raw_loc = resp_loc.json().get("alerts", [])
                    for a in raw_loc:
                        alerts.append(
                            {
                                "event": a.get("disaster_type")
                                or a.get("events")
                                or "Disaster Alert",
                                "headline": f"{a.get('disaster_type', 'Alert')} - {a.get('area_description', 'India')}",
                                "severity": a.get("severity")
                                or a.get("severity_color", "ALERT"),
                                "severity_color": a.get("severity_color"),
                                "area_desc": a.get("area_description"),
                                "effective": a.get("effective_start_time"),
                                "expires": a.get("effective_end_time"),
                                "instruction": a.get("warning_message"),
                                "sender_name": a.get("alert_source")
                                or "NDMA / IMD India",
                                "identifier": a.get("identifier"),
                                "alert_source": a.get("alert_source"),
                            }
                        )

                # 2. If no direct radius match, search FetchAllAlertDetails with centroid distance matching
                if not alerts:
                    url_all = f"{sachet_base}/FetchAllAlertDetails"
                    resp_all = await client.post(url_all)
                    if resp_all.status_code == 200:
                        all_items = resp_all.json()
                        for a in all_items:
                            centroid = a.get("centroid")
                            is_match = False
                            if centroid and "," in str(centroid):
                                try:
                                    c_parts = str(centroid).split(",")
                                    c_lon, c_lat = float(c_parts[0]), float(c_parts[1])
                                    dist = haversine_distance_km(
                                        latitude, longitude, c_lat, c_lon
                                    )
                                    if dist <= 120.0:
                                        is_match = True
                                except (ValueError, IndexError):
                                    pass

                            # Area description textual check (e.g. "Chennai", "Tamil Nadu")
                            area_desc = str(a.get("area_description", "")).lower()
                            if (
                                "chennai" in area_desc
                                and haversine_distance_km(
                                    latitude, longitude, 13.0827, 80.2707
                                )
                                <= 150.0
                            ):
                                is_match = True

                            if is_match:
                                alerts.append(
                                    {
                                        "event": a.get("disaster_type")
                                        or "Disaster Alert",
                                        "headline": f"{a.get('disaster_type', 'Alert')} - {a.get('area_description', '')}",
                                        "severity": a.get("severity")
                                        or a.get("severity_color", "ALERT"),
                                        "severity_color": a.get("severity_color"),
                                        "area_desc": a.get("area_description"),
                                        "effective": a.get("effective_start_time"),
                                        "expires": a.get("effective_end_time"),
                                        "instruction": a.get("warning_message"),
                                        "sender_name": a.get("alert_source")
                                        or "NDMA / IMD India",
                                        "identifier": a.get("identifier"),
                                        "alert_source": a.get("alert_source"),
                                        "centroid": a.get("centroid"),
                                    }
                                )

                summary = (
                    f"Found {len(alerts)} official government emergency alerts from SACHET NDMA (IMD / CWC / SDMA). Top alert: {alerts[0]['event']} ({alerts[0]['sender_name']})."
                    if alerts
                    else "No active official government emergency warnings or CAP bulletins currently issued by NDMA / IMD for this location."
                )

                res = make_evidence_envelope(
                    source="SACHET - NDMA India Integrated Alert System (IMD / CWC / SDMA)",
                    source_type="OFFICIAL",
                    summary=summary,
                    data={
                        "active_alerts_count": len(alerts),
                        "alerts": alerts,
                        "coverage_region": "INDIA (NATIONAL & STATE CAP)",
                    },
                    location={"latitude": latitude, "longitude": longitude},
                    confidence="GOVERNMENT_AUTHORITATIVE",
                    limitations=[
                        "Official Common Alerting Protocol (CAP) feed from NDMA, IMD, Central Water Commission (CWC), and State Disaster Management Authorities.",
                        "Hyper-local street-level storm drain inundation may precede municipal bulletin issuance.",
                    ],
                    extra_root_fields={
                        "active_alerts_count": len(alerts),
                        "alerts": alerts,
                    },
                )
                _ALERT_CACHE[cache_key] = (now, res)
                return res
        except (httpx.HTTPError, OSError, ValueError, KeyError) as exc:
            logger.warning(f"SACHET NDMA Alerts query error: {exc}")

    # --------------------------------------------------------------------------
    # CASE C: INTERNATIONAL / OTHER COUNTRIES (GDACS Secondary Aggregated Feed)
    # --------------------------------------------------------------------------
    try:
        gdacs_url = "https://www.gdacs.org/xml/rss.xml"
        async with httpx.AsyncClient(
            timeout=5.0, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = await client.get(gdacs_url)
            if resp.status_code == 200:
                root = ET.fromstring(resp.content)
                items = root.findall("./channel/item")
                for item in items[:15]:
                    title = item.findtext("title", "")
                    desc = item.findtext("description", "")
                    link = item.findtext("link", "")
                    pub_date = item.findtext("pubDate", "")
                    alerts.append(
                        {
                            "event": title,
                            "headline": title,
                            "severity": "Severe"
                            if "red" in title.lower() or "orange" in title.lower()
                            else "Moderate",
                            "urgency": "Expected",
                            "certainty": "Observed",
                            "area_desc": "International / Multi-Hazard",
                            "effective": pub_date,
                            "instruction": desc[:250],
                            "sender_name": "GDACS / UN OCHA & EC JRC",
                            "report_link": link,
                        }
                    )

                summary = (
                    f"Found {len(alerts)} international multi-hazard disaster bulletins from GDACS. Top bulletin: {alerts[0]['event']}."
                    if alerts
                    else "No active international disaster bulletins from GDACS for this location."
                )
                res = make_evidence_envelope(
                    source="GDACS / WMO Severe Weather Information Centre (International Aggregator)",
                    source_type="AGGREGATED",
                    summary=summary,
                    data={
                        "active_alerts_count": len(alerts),
                        "alerts": alerts,
                        "coverage_region": "GLOBAL / INTERNATIONAL",
                    },
                    location={"latitude": latitude, "longitude": longitude},
                    confidence="MULTI_AGENCY_AGGREGATED",
                    limitations=[
                        "Aggregated macro-level global disaster feed; NOT a substitute for local national disaster management authority.",
                        "Coordinate falls outside dedicated US/India national warning pipelines.",
                    ],
                    extra_root_fields={
                        "active_alerts_count": len(alerts),
                        "alerts": alerts,
                    },
                )
                _ALERT_CACHE[cache_key] = (now, res)
                return res
    except (httpx.HTTPError, OSError, ValueError, KeyError, ET.ParseError) as exc:
        logger.warning(f"GDACS international alerts fallback query error: {exc}")

    fallback_source = (
        "NOAA National Weather Service"
        if is_us_region
        else "SACHET NDMA India"
        if is_india_region
        else "GDACS / WMO Severe Weather Information Centre (International Aggregator)"
    )
    fallback_source_type = "OFFICIAL" if (is_us_region or is_india_region) else "AGGREGATED"
    fallback_limitations = (
        ["No active published CAP bulletins found for target coordinates."]
        if (is_us_region or is_india_region)
        else [
            "Aggregated macro-level global disaster feed; NOT a substitute for local national disaster management authority.",
            "Coordinate falls outside dedicated US/India national warning pipelines.",
        ]
    )

    res_fallback = make_evidence_envelope(
        source=fallback_source,
        source_type=fallback_source_type,
        summary="No active official government emergency warnings returned for this location.",
        data={"active_alerts_count": 0, "alerts": []},
        location={"latitude": latitude, "longitude": longitude},
        confidence="GOVERNMENT_AUTHORITATIVE" if (is_us_region or is_india_region) else "MULTI_AGENCY_AGGREGATED",
        limitations=fallback_limitations,
        extra_root_fields={"active_alerts_count": 0, "alerts": []},
    )
    return res_fallback


# ==============================================================================
# 10. GDACS Global Disaster Alerts Tool
# ==============================================================================
@mcp.tool()
async def get_global_disaster_alerts(
    limit: int = 5,
) -> dict[str, Any]:
    """
    Query active global multi-hazard disaster alerts (Floods, Tropical Cyclones, Earthquakes, Volcanoes, Wildfires, Droughts) from GDACS (UN & European Commission).

    :param limit: Maximum number of active global disaster bulletins to return (default 5)
    """
    limit = max(1, min(20, limit))
    url = "https://www.gdacs.org/xml/rss.xml"
    try:
        async with httpx.AsyncClient(
            timeout=5.0, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            root = ET.fromstring(resp.content)

        items = root.findall("./channel/item")
        alerts = []
        for item in items[:limit]:
            title = item.findtext("title", "Disaster Alert")
            description = item.findtext("description", "")
            pub_date = item.findtext("pubDate", "")
            link = item.findtext("link", "")

            alerts.append(
                {
                    "title": title,
                    "description": description[:200] + "..."
                    if len(description) > 200
                    else description,
                    "published_at": pub_date,
                    "report_link": link,
                }
            )

        summary = f"GDACS active multi-hazard feed contains {len(items)} global disaster bulletins. Top alert: {alerts[0]['title'] if alerts else 'None'}."
        res = make_evidence_envelope(
            source="GDACS (UN OCHA & European Commission Joint Research Centre)",
            source_type="AGGREGATED",
            summary=summary,
            data={
                "global_alerts_count": len(alerts),
                "alerts": alerts,
                "total_feed_items": len(items),
            },
            location={},
            confidence="MULTI_AGENCY_AGGREGATED",
            limitations=[
                "Aggregated macro-level global disaster impact estimates; does NOT replace local municipality ground situational reports."
            ],
            extra_root_fields={"global_alerts_count": len(alerts), "alerts": alerts},
        )
        return res
    except (httpx.HTTPError, OSError, ValueError, KeyError, ET.ParseError) as exc:
        logger.error(f"GDACS RSS parse error: {exc}")
        return make_evidence_envelope(
            source="GDACS",
            source_type="AGGREGATED",
            summary=f"Failed to retrieve GDACS disaster feed: {exc}",
            data={"global_alerts_count": 0, "alerts": [], "error": str(exc)},
            confidence="UNAVAILABLE",
            limitations=["GDACS feed unreachable."],
            extra_root_fields={
                "global_alerts_count": 0,
                "alerts": [],
                "error": f"Failed to retrieve GDACS disaster feed: {exc}",
            },
        )


# ==============================================================================
# 11. Open-Meteo Air Quality Hazards Tool
# ==============================================================================
@mcp.tool()
async def get_air_quality_hazards(
    latitude: float,
    longitude: float,
) -> dict[str, Any]:
    """
    Query real-time atmospheric pollutants and Air Quality Index (AQI) from Open-Meteo & Copernicus CAMS atmospheric models.

    :param latitude: Target latitude (-90.0 to 90.0)
    :param longitude: Target longitude (-180.0 to 180.0)
    """
    url = "https://air-quality-api.open-meteo.com/v1/air-quality"
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "current": "us_aqi,european_aqi,pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone",
    }

    try:
        async with httpx.AsyncClient(
            timeout=4.0, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        current = data.get("current", {})
        us_aqi = current.get("us_aqi", 0)
        pm25 = current.get("pm2_5", 0.0)
        pm10 = current.get("pm10", 0.0)
        co = current.get("carbon_monoxide", 0.0)
        no2 = current.get("nitrogen_dioxide", 0.0)
        so2 = current.get("sulphur_dioxide", 0.0)
        o3 = current.get("ozone", 0.0)

        if us_aqi <= 50:
            category = "GOOD"
            hazard_level = "LOW"
        elif us_aqi <= 100:
            category = "MODERATE"
            hazard_level = "LOW"
        elif us_aqi <= 150:
            category = "UNHEALTHY_FOR_SENSITIVE_GROUPS"
            hazard_level = "MODERATE"
        elif us_aqi <= 200:
            category = "UNHEALTHY"
            hazard_level = "HIGH"
        elif us_aqi <= 300:
            category = "VERY_UNHEALTHY"
            hazard_level = "VERY_HIGH"
        else:
            category = "HAZARDOUS"
            hazard_level = "CRITICAL"

        summary = f"Air Quality Index is {us_aqi} ({category}, Hazard: {hazard_level}). PM2.5: {pm25} µg/m³, PM10: {pm10} µg/m³, CO: {co} µg/m³."

        res = make_evidence_envelope(
            source="Open-Meteo Air Quality & Copernicus CAMS",
            source_type="MODEL",
            summary=summary,
            data={
                "us_aqi": us_aqi,
                "european_aqi": current.get("european_aqi"),
                "category": category,
                "hazard_level": hazard_level,
                "pollutants": {
                    "pm2_5_ug_m3": pm25,
                    "pm10_ug_m3": pm10,
                    "carbon_monoxide_ug_m3": co,
                    "nitrogen_dioxide_ug_m3": no2,
                    "sulphur_dioxide_ug_m3": so2,
                    "ozone_ug_m3": o3,
                },
            },
            location={"latitude": latitude, "longitude": longitude},
            confidence="ATMOSPHERIC_MODEL_ESTIMATE",
            limitations=[
                "Atmospheric composition model forecast; ground-level localized toxic plumes from industrial leaks may vary."
            ],
            extra_root_fields={
                "us_aqi": us_aqi,
                "european_aqi": current.get("european_aqi"),
                "category": category,
                "hazard_level": hazard_level,
                "pollutants": {
                    "pm2_5_ug_m3": pm25,
                    "pm10_ug_m3": pm10,
                    "carbon_monoxide_ug_m3": co,
                    "nitrogen_dioxide_ug_m3": no2,
                    "sulphur_dioxide_ug_m3": so2,
                    "ozone_ug_m3": o3,
                },
            },
        )
        return res
    except (httpx.HTTPError, OSError, ValueError) as exc:
        logger.error(f"Open-Meteo Air Quality error: {exc}")
        return make_evidence_envelope(
            source="Open-Meteo Air Quality",
            source_type="MODEL",
            summary=f"Air quality lookup failed: {exc}",
            data={"error": str(exc)},
            location={"latitude": latitude, "longitude": longitude},
            confidence="UNAVAILABLE",
            limitations=["Open-Meteo Air Quality API request failed or timed out."],
            extra_root_fields={
                "error": f"Failed to retrieve air quality data: {exc}",
                "us_aqi": 0,
                "category": "UNKNOWN",
                "hazard_level": "UNKNOWN",
            },
        )


# ==============================================================================
# 12. Search Emergency Infrastructure Tool (OpenStreetMap / Overpass)
# ==============================================================================
@mcp.tool()
async def search_emergency_infrastructure(
    latitude: float,
    longitude: float,
    infrastructure_type: str = "hospital",
    radius_meters: int = 3000,
) -> dict[str, Any]:
    """
    Search for critical emergency infrastructure (hospitals, fire stations, police stations, shelters, flood barriers, water infrastructure, helipads) from OpenStreetMap.

    :param latitude: Target latitude (-90.0 to 90.0)
    :param longitude: Target longitude (-180.0 to 180.0)
    :param infrastructure_type: Type of infrastructure ('hospital', 'fire_station', 'police', 'shelter', 'flood_barrier', 'water_tower', 'helipad')
    :param radius_meters: Search radius in meters (500 to 15000, default 3000)
    """
    radius_meters = max(500, min(15000, radius_meters))
    type_normalized = infrastructure_type.lower().strip().replace(" ", "_")

    tag_map = {
        "hospital": 'node["amenity"="hospital"]',
        "fire_station": 'node["amenity"="fire_station"]',
        "police": 'node["amenity"="police"]',
        "shelter": 'node["amenity"="shelter"]',
        "flood_barrier": 'node["man_made"="flood_barrier"]',
        "water_tower": 'node["man_made"="water_tower"]',
        "helipad": 'node["aeroway"="helipad"]',
    }
    osm_filter = tag_map.get(type_normalized, f'node["amenity"="{type_normalized}"]')

    overpass_query = f"""[out:json][timeout:6];(
        {osm_filter}(around:{radius_meters},{latitude},{longitude});
    );out body 10;"""

    overpass_endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://lz4.overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
    ]

    elements: list[dict[str, Any]] = []
    for ep in overpass_endpoints:
        try:
            async with httpx.AsyncClient(
                timeout=4.0, headers={"User-Agent": USER_AGENT}
            ) as client:
                resp = await client.post(ep, data={"data": overpass_query})
                if resp.status_code == 200:
                    elements = resp.json().get("elements", [])
                    break
        except (httpx.HTTPError, OSError, ValueError):
            logger.debug(f"Overpass mirror {ep} timed out or failed, trying next...")

    items = []
    for el in elements:
        el_lat = el.get("lat")
        el_lon = el.get("lon")
        if el_lat is not None and el_lon is not None:
            dist_km = haversine_distance_km(
                latitude, longitude, float(el_lat), float(el_lon)
            )
            tags = el.get("tags", {})
            name = (
                tags.get("name")
                or tags.get("description")
                or f"Unnamed {type_normalized.title()}"
            )
            items.append(
                {
                    "name": name,
                    "type": type_normalized,
                    "latitude": float(el_lat),
                    "longitude": float(el_lon),
                    "distance_km": dist_km,
                    "tags": tags,
                    "osm_id": el.get("id"),
                }
            )

    items.sort(key=lambda x: x["distance_km"])

    if not items:
        nom_result = await find_nearby_resource(
            latitude=latitude,
            longitude=longitude,
            resource_type=type_normalized,
            radius_km=radius_meters / 1000.0,
        )  # type: ignore[arg-type]
        if nom_result.get("found") and nom_result.get("nearest"):
            nr = nom_result["nearest"]
            items.append(
                {
                    "name": nr["name"],
                    "type": type_normalized,
                    "latitude": nr["latitude"],
                    "longitude": nr["longitude"],
                    "distance_km": nr["distance_km"],
                    "display_name": nr.get("display_name"),
                }
            )

    summary = (
        f"Found {len(items)} {type_normalized} facilities within {radius_meters}m. Nearest: {items[0]['name']} ({items[0]['distance_km']} km away)."
        if items
        else f"No {type_normalized} facilities mapped within {radius_meters}m in OpenStreetMap."
    )

    res = make_evidence_envelope(
        source="OpenStreetMap / Overpass API",
        source_type="MAPPED",
        summary=summary,
        data={
            "infrastructure_type": type_normalized,
            "facilities_found": len(items),
            "facilities": items[:10],
        },
        location={
            "latitude": latitude,
            "longitude": longitude,
            "radius_meters": radius_meters,
        },
        confidence="COMMUNITY_MAPPED",
        limitations=[
            "Crowdsourced geospatial database; operational readiness, emergency room capacity, or flood ingress at facility are unverified."
        ],
        extra_root_fields={
            "infrastructure_type": type_normalized,
            "search_radius_meters": radius_meters,
            "facilities_found": len(items),
            "facilities": items[:10],
        },
    )
    return res


# ==============================================================================
# Server Entrypoint
# ==============================================================================
if __name__ == "__main__":
    port: int = int(os.getenv("PORT", "8001"))
    host: str = os.getenv("HOST", "0.0.0.0")
    logger.info(
        f"Starting Tocsin Mock Services MCP Server on {host}:{port} (SSE transport) with 13 specialized tools..."
    )
    mcp.run(transport="sse", host=host, port=port)
