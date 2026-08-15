"""
Live Test Suite for the 6 FastMCP Tools in Tocsin
Executes live queries against real public APIs (Open-Meteo, Nominatim, OSRM) and backend endpoints.
"""

import httpx
import pytest
from server import (
    BACKEND_URL,
    calculate_eta,
    dispatch_resolution_action,
    find_nearby_resource,
    get_incident_status,
    get_weather_risk,
    notify_stakeholders,
)


@pytest.mark.asyncio
async def test_tool_1_get_weather_risk_real_api():
    """Test get_weather_risk against live Open-Meteo API."""
    # Coordinates for Mumbai (coastal flood risk zone)
    res = await get_weather_risk(latitude=19.0760, longitude=72.8777, hours_ahead=12)
    assert "error" not in res
    assert res["risk_label"] in ("LOW", "MODERATE", "SEVERE")
    assert "max_rainfall_intensity_mm_per_hr" in res
    assert "max_precipitation_probability_pct" in res
    assert res["forecast_window_hours"] == 12


@pytest.mark.asyncio
async def test_tool_2_find_nearby_resource_real_api():
    """Test find_nearby_resource against live OpenStreetMap Nominatim API."""
    # Search for hospitals near downtown Manhattan
    res = await find_nearby_resource(
        latitude=40.7128, longitude=-74.0060, resource_type="hospital", radius_km=10.0
    )
    assert res.get("found") is True
    assert "nearest" in res
    nearest = res["nearest"]
    assert "name" in nearest
    assert "latitude" in nearest
    assert "longitude" in nearest
    assert nearest["distance_km"] >= 0.0


@pytest.mark.asyncio
async def test_tool_2_find_nearby_resource_mumbai_coordinates_accuracy():
    """Test find_nearby_resource at (19.07, 72.87) to verify nearest hospital is geographically plausible (<5 km)."""
    res = await find_nearby_resource(
        latitude=19.07, longitude=72.87, resource_type="hospital", radius_km=15.0
    )
    assert res.get("found") is True
    assert "nearest" in res
    nearest = res["nearest"]
    assert nearest["distance_km"] < 5.0  # Must be close local hospital (<5km), not distant outlier
    assert "name" in nearest
    assert "summary" in res
    assert str(nearest["distance_km"]) in res["summary"]


@pytest.mark.asyncio
async def test_tool_3_calculate_eta_real_api():
    """Test calculate_eta with real OSRM routing / Haversine fallback."""
    # Route from Times Square to Central Park
    res = await calculate_eta(
        origin_lat=40.7580,
        origin_lng=-73.9855,
        dest_lat=40.785091,
        dest_lng=-73.968285,
        mode="driving",
    )
    assert "error" not in res
    assert res["distance_km"] > 0.0
    assert res["duration_minutes"] > 0.0
    assert "estimated" in res
    assert res["mode"] == "driving"


@pytest.mark.asyncio
async def test_tool_4_and_5_incident_status_and_resolution():
    """Test get_incident_status and dispatch_resolution_action against live backend."""
    test_inc_id = "inc-mcp-test-456"

    # 1. Create a test incident via backend API
    async with httpx.AsyncClient(timeout=3.0) as client:
        create_resp = await client.post(
            f"{BACKEND_URL}/api/incidents",
            json={
                "incident_id": test_inc_id,
                "title": "Severe River Spill Contamination",
                "event_type": "WATER_CONTAMINATION",
            },
        )
        assert create_resp.status_code in (200, 201)

    # 2. Test missing incident lookup
    res_status_missing = await get_incident_status(incident_id="non-existent-inc-999")
    assert res_status_missing.get("status_code") == 404 or "error" in res_status_missing

    # 3. Test dispatching resolution action against the incident
    res_dispatch = await dispatch_resolution_action(
        incident_id=test_inc_id,
        tool_name="deploy_mobile_water_purification",
        action_description="Dispatched 2 reverse-osmosis filtration trucks.",
        recovery_duration_seconds=2.0,
        actor="AgoraVoiceAgentTest",
    )
    assert res_dispatch.get("dispatched") is True
    assert res_dispatch["incident_id"] == test_inc_id
    assert res_dispatch["status"] == "RESOLVING"

    # 4. Retrieve status of the incident
    res_status = await get_incident_status(incident_id=test_inc_id)
    assert res_status.get("incident_id") == test_inc_id
    assert res_status["title"] == "Severe River Spill Contamination"
    assert len(res_status["actions_taken"]) >= 1


@pytest.mark.asyncio
async def test_tool_6_notify_stakeholders_mock_fallback():
    """Test notify_stakeholders with safe fallback when TELEGRAM_BOT_TOKEN is unset."""
    res = await notify_stakeholders(
        incident_id="inc-mcp-test-456",
        message="Flash flood level rising in Sector 4. Immediate evacuation advised.",
        chat_id="emergency_dispatch_channel",
    )
    assert res["sent"] is False
    assert res["mode"] == "MOCK_FALLBACK"
    assert "status_for_agent" in res
    assert "NOT ACTUALLY SENT" in res["status_for_agent"]
    assert "simulated_message" in res
    assert "Sector 4" in res["simulated_message"]
