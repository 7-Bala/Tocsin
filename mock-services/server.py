"""
Tocsin Mock Services - MCP Tool Server
Exposes 6 specialized disaster coordination tools to Agora / Gemini Live via FastMCP.
"""

import logging
import math
import os
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
BACKEND_URL: str = os.getenv("BACKEND_URL", "http://backend:8000").rstrip("/")
USER_AGENT: str = "TocsinDisasterCoordination/1.0 (contact: hackathon@tocsin.app)"

# Initialize FastMCP Server
mcp = FastMCP(
    "TocsinEmergencyTools",
    instructions="Real-time disaster coordination tools for weather risk, resource location, ETA routing, incident status, action dispatch, and stakeholder notification.",
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
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "hourly": "precipitation,precipitation_probability,rain",
        "forecast_days": 1,
        "timezone": "auto",
    }

    try:
        async with httpx.AsyncClient(timeout=3.0, headers={"User-Agent": USER_AGENT}) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        hourly = data.get("hourly", {})
        precip_list = hourly.get("precipitation", [])[:hours_ahead]
        prob_list = hourly.get("precipitation_probability", [])[:hours_ahead]

        max_rain_intensity = max(precip_list) if precip_list else 0.0
        avg_rain_intensity = round(sum(precip_list) / max(1, len(precip_list)), 2) if precip_list else 0.0
        max_prob = max(prob_list) if prob_list else 0

        # Determine risk label based on rainfall thresholds
        if max_rain_intensity >= 15.0 or (max_rain_intensity >= 8.0 and max_prob >= 75):
            risk_label = "SEVERE"
        elif max_rain_intensity >= 4.0 or max_prob >= 50:
            risk_label = "MODERATE"
        else:
            risk_label = "LOW"

        return {
            "latitude": latitude,
            "longitude": longitude,
            "forecast_window_hours": hours_ahead,
            "max_rainfall_intensity_mm_per_hr": max_rain_intensity,
            "avg_rainfall_intensity_mm_per_hr": avg_rain_intensity,
            "max_precipitation_probability_pct": max_prob,
            "risk_label": risk_label,
            "elevation_meters": data.get("elevation", 0.0),
        }
    except (httpx.HTTPError, OSError, ValueError, KeyError) as exc:
        logger.error(f"Open-Meteo API error: {exc}")
        return {
            "error": f"Failed to retrieve weather data: {exc}",
            "risk_label": "UNKNOWN",
        }


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
    delta_lat = radius_km / 111.0  # Approx 111 km per degree latitude
    cos_lat = max(0.01, math.cos(math.radians(latitude)))
    delta_lon = radius_km / (111.0 * cos_lat)
    viewbox = f"{longitude - delta_lon},{latitude + delta_lat},{longitude + delta_lon},{latitude - delta_lat}"

    url = "https://nominatim.openstreetmap.org/search"
    
    # 1. First query with bounded=1 (strict bounding box) and high limit (25) to find all local candidates
    params = {
        "q": query,
        "format": "jsonv2",
        "limit": 25,
        "viewbox": viewbox,
        "bounded": 1,
    }

    try:
        async with httpx.AsyncClient(timeout=4.0, headers={"User-Agent": USER_AGENT}) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            results = resp.json()

            # If strict bounding box yielded no results, fallback to soft bounded=0
            if not results:
                logger.info(f"No results with bounded=1 for {resource_type}. Falling back to bounded=0...")
                params["bounded"] = 0
                params["limit"] = 10
                resp_fallback = await client.get(url, params=params)
                resp_fallback.raise_for_status()
                results = resp_fallback.json()

        if not results:
            return {
                "found": False,
                "resource_type": resource_type,
                "message": f"No {resource_type} found within {radius_km} km radius of ({latitude}, {longitude}).",
            }

        # Calculate exact Haversine distance for every candidate and sort strictly ascending
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

        # Sort strictly by geographical distance
        matches.sort(key=lambda x: x["distance_km"])
        nearest = matches[0]

        return {
            "found": True,
            "resource_type": resource_type,
            "nearest": nearest,
            "candidate_count": len(matches),
            "summary": f"Nearest {resource_type} is {nearest['name']} located {nearest['distance_km']} km away at ({nearest['latitude']}, {nearest['longitude']}).",
        }
    except (httpx.HTTPError, OSError, ValueError, KeyError) as exc:
        logger.error(f"Nominatim API error: {exc}")
        return {
            "found": False,
            "error": f"Resource lookup failed: {exc}",
            "resource_type": resource_type,
        }


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
        return {
            "error": f"Invalid mode '{mode}'. Must be 'driving' or 'walking'."
        }

    osrm_mode = "car" if mode == "driving" else "foot"
    url = f"https://router.project-osrm.org/route/v1/{osrm_mode}/{origin_lng},{origin_lat};{dest_lng},{dest_lat}"
    params = {"overview": "false", "steps": "false"}

    try:
        async with httpx.AsyncClient(timeout=2.0, headers={"User-Agent": USER_AGENT}) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        routes = data.get("routes", [])
        if routes:
            primary_route = routes[0]
            distance_meters = primary_route.get("distance", 0.0)
            duration_seconds = primary_route.get("duration", 0.0)

            return {
                "distance_km": round(distance_meters / 1000.0, 2),
                "duration_minutes": round(duration_seconds / 60.0, 1),
                "mode": mode,
                "estimated": False,
                "source": "OSRM Router",
            }
        else:
            raise ValueError("No routes returned by OSRM")
    except (httpx.HTTPError, OSError, ValueError, KeyError) as exc:
        logger.warning(f"OSRM Routing failed ({exc}), falling back to Haversine speed estimation.")
        dist_km = haversine_distance_km(origin_lat, origin_lng, dest_lat, dest_lng)
        # Assumed speeds: 35 km/h driving (city emergency traffic), 4.5 km/h walking
        speed_kmh = 35.0 if mode == "driving" else 4.5
        est_duration_min = round((dist_km / speed_kmh) * 60.0, 1)

        return {
            "distance_km": dist_km,
            "duration_minutes": est_duration_min,
            "mode": mode,
            "estimated": True,
            "source": "Haversine Estimation Fallback",
        }


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
            return {
                "incident_id": data.get("incident_id"),
                "title": data.get("title"),
                "status": data.get("status"),
                "severity": data.get("severity"),
                "metrics": data.get("metrics"),
                "symptoms": data.get("symptoms"),
                "actions_taken": data.get("actions_taken"),
                "updated_at": data.get("updated_at"),
            }
    except (httpx.HTTPError, OSError, ValueError) as exc:
        logger.error(f"Backend GET /api/incidents/{incident_id} failed: {exc}")
        return {
            "error": f"Failed to retrieve incident status: {exc}",
            "incident_id": incident_id,
        }


# ==============================================================================
# 5. Dispatch Resolution Action Tool
# ==============================================================================
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
            return {
                "dispatched": True,
                "incident_id": incident_id,
                "tool_name": tool_name,
                "status": data.get("status"),
                "severity": data.get("severity"),
                "metrics": data.get("metrics"),
                "actions_taken": data.get("actions_taken"),
            }
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

    # Explicit, LLM-readable mock response when token is not configured in dev
    if not token or not token.strip():
        logger.info("TELEGRAM_BOT_TOKEN not configured. Returning explicit mock fallback.")
        return {
            "sent": False,
            "mode": "MOCK_FALLBACK",
            "status_for_agent": (
                "NOT ACTUALLY SENT - this is a simulated/mock response because no live Telegram bot token is configured. "
                "You MUST explicitly tell the user that this message was NOT actually sent or transmitted to real stakeholders in the real world."
            ),
            "incident_id": incident_id,
            "chat_id": chat_id,
            "simulated_message": formatted_text,
            "notice": "Simulated broadcast only. Real Telegram bot credentials are not configured.",
        }

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
            return {
                "sent": True,
                "incident_id": incident_id,
                "chat_id": chat_id,
                "message_id": data.get("result", {}).get("message_id"),
                "status_for_agent": "Successfully transmitted to live Telegram channel.",
            }
    except (httpx.HTTPError, OSError, ValueError) as exc:
        # Never log or leak the bot token in logs or response
        logger.error(f"Failed to transmit Telegram notification (redacted token): {exc}")
        return {
            "sent": False,
            "error": "Telegram transmission failed. Check network or chat ID.",
            "incident_id": incident_id,
            "status_for_agent": "FAILED to send Telegram alert due to network or gateway error.",
        }


# ==============================================================================
# Server Entrypoint
# ==============================================================================
if __name__ == "__main__":
    port: int = int(os.getenv("PORT", "8001"))
    host: str = os.getenv("HOST", "0.0.0.0")
    logger.info(
        f"Starting Tocsin Mock Services MCP Server on {host}:{port} (SSE transport) with 6 tools..."
    )
    mcp.run(transport="sse", host=host, port=port)
