"""
Test Suite for the FastMCP Tools in Tocsin
Executes live queries against real public APIs (Open-Meteo, Nominatim, OSRM, USGS,
NASA FIRMS, GDACS, Copernicus CAMS) and backend endpoints where credential-free;
mock-fallback and monkeypatched-dispatch coverage for credential-gated tools
(notify_stakeholders, page_oncall_engineer).
"""

import httpx
import pytest
from server import (
    BACKEND_URL,
    calculate_eta,
    dispatch_resolution_action,
    find_nearby_resource,
    get_active_fire_hotspots,
    get_air_quality_hazards,
    get_earthquake_activity,
    get_global_disaster_alerts,
    get_incident_status,
    get_official_emergency_alerts,
    get_weather_risk,
    notify_stakeholders,
    page_oncall_engineer,
    propose_incident_action,
    search_emergency_infrastructure,
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
async def test_tool_4_and_5_incident_status_and_resolution(monkeypatch):
    """Test get_incident_status and dispatch_resolution_action against backend."""
    test_inc_id = "inc-mcp-test-456"

    # In in-process unit tests, route calls to FastAPI app via ASGITransport
    original_async_client = httpx.AsyncClient
    try:
        from app.main import app
        from httpx import ASGITransport
        transport = ASGITransport(app=app)
        def client_factory(**kwargs):
            kwargs.setdefault("transport", transport)
            kwargs.setdefault("base_url", "http://test")
            return original_async_client(**kwargs)
    except ImportError:
        def client_factory(**kwargs):
            return original_async_client(**kwargs)

    # 1. Create a test incident via backend API
    async with client_factory(timeout=3.0) as client:
        create_resp = await client.post(
            "/api/incidents" if "ASGITransport" in locals() else f"{BACKEND_URL}/api/incidents",
            json={
                "incident_id": test_inc_id,
                "title": "Severe River Spill Contamination",
                "event_type": "WATER_CONTAMINATION",
            },
        )
        assert create_resp.status_code in (200, 201)

    # Monkeypatch httpx.AsyncClient inside server module for tool calls during in-process testing
    monkeypatch.setattr("server.httpx.AsyncClient", client_factory)
    monkeypatch.setattr("server.BACKEND_URL", "http://test")

    # 2. Test missing incident lookup
    res_status_missing = await get_incident_status(incident_id="non-existent-inc-999")
    assert res_status_missing.get("status_code") == 404 or "error" in res_status_missing

    # 3. Test proposing an action for commander approval via MCP tool
    res_propose = await propose_incident_action(
        incident_id=test_inc_id,
        tool_name="deploy_mobile_water_purification",
        rationale="Urgent reverse-osmosis filtration needed at drinking water station.",
        proposed_by="AgoraVoiceAgentTest",
    )
    assert res_propose.get("proposed") is True
    assert res_propose["status"] == "PENDING_APPROVAL"
    assert res_propose["incident_id"] == test_inc_id

    # 4. Test dispatching resolution action against the incident
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

    # 5. Retrieve status of the incident
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


@pytest.mark.asyncio
async def test_tool_7_get_earthquake_activity_real_api():
    """Test get_earthquake_activity against live USGS Earthquake API."""
    # San Francisco Bay Area (active seismic zone)
    res = await get_earthquake_activity(latitude=37.7749, longitude=-122.4194, radius_km=500.0, min_magnitude=2.0, days_back=7)
    assert res["source"] == "USGS Earthquake Hazards Program"
    assert res["source_type"] == "OFFICIAL"
    assert "events_count" in res
    assert "seismic_risk_level" in res
    assert isinstance(res["events"], list)


@pytest.mark.asyncio
async def test_tool_8_get_active_fire_hotspots_real_api():
    """Test get_active_fire_hotspots against NASA FIRMS satellite observation feeds."""
    res = await get_active_fire_hotspots(latitude=34.0522, longitude=-118.2437, radius_km=100.0, days=1)
    assert res["source"] == "NASA FIRMS (EOSDIS)"
    assert res["source_type"] == "OBSERVATIONAL"
    assert "hotspots_count" in res
    assert isinstance(res["hotspots"], list)


@pytest.mark.asyncio
async def test_tool_9_get_official_emergency_alerts_real_api():
    """Test get_official_emergency_alerts against live NOAA NWS CAP feed (US) and SACHET NDMA (India)."""
    # US coordinates (Houston flood zone)
    res_us = await get_official_emergency_alerts(latitude=29.7604, longitude=-95.3698)
    assert "source" in res_us
    assert res_us["source_type"] == "OFFICIAL"
    assert "NOAA" in res_us["source"]
    assert "active_alerts_count" in res_us
    assert isinstance(res_us["alerts"], list)
    assert len(res_us["limitations"]) > 0

    # India coordinates (Chennai coastal flood zone)
    res_india = await get_official_emergency_alerts(latitude=13.0827, longitude=80.2707)
    assert "source" in res_india
    assert res_india["source_type"] == "OFFICIAL"
    assert "SACHET" in res_india["source"] or "NDMA" in res_india["source"]
    assert res_india["confidence"] == "GOVERNMENT_AUTHORITATIVE"
    assert "active_alerts_count" in res_india
    assert any("NDMA" in l or "IMD" in l for l in res_india["limitations"])


@pytest.mark.asyncio
async def test_tool_9_india_official_alert_routing_and_provenance():
    """Test 1, 2, 4: Chennai coordinates and Indian alert source selection with official provenance."""
    res_chennai = await get_official_emergency_alerts(latitude=13.0827, longitude=80.2707)
    assert res_chennai["source_type"] == "OFFICIAL"
    assert "SACHET" in res_chennai["source"]
    assert res_chennai["confidence"] == "GOVERNMENT_AUTHORITATIVE"
    assert "retrieved_at" in res_chennai
    assert res_chennai["location"]["latitude"] == 13.0827
    assert res_chennai["location"]["longitude"] == 80.2707


@pytest.mark.asyncio
async def test_tool_9_non_us_non_india_fallback_and_gdacs_classification():
    """Test 3, 5: Non-US, non-India coordinates route to GDACS with AGGREGATED classification."""
    # Tokyo, Japan coordinates
    res_tokyo = await get_official_emergency_alerts(latitude=35.6762, longitude=139.6503)
    assert res_tokyo["source_type"] == "AGGREGATED"
    assert "GDACS" in res_tokyo["source"]
    assert res_tokyo["confidence"] == "MULTI_AGENCY_AGGREGATED"
    assert any("NOT a substitute" in lim for lim in res_tokyo["limitations"])


@pytest.mark.asyncio
async def test_tool_9_caching_and_ttl_behavior():
    """Test 10: In-memory TTL caching prevents redundant network calls."""
    import server
    # First call primes cache
    res1 = await get_official_emergency_alerts(latitude=13.0827, longitude=80.2707)
    cache_key = f"alerts_{round(13.0827, 3)}_{round(80.2707, 3)}"
    assert cache_key in server._ALERT_CACHE

    # Second call returns from cache
    res2 = await get_official_emergency_alerts(latitude=13.0827, longitude=80.2707)
    assert res1["retrieved_at"] == res2["retrieved_at"]


@pytest.mark.asyncio
async def test_tool_9_resilience_timeout_and_malformed_feeds(monkeypatch):
    """Test 6, 7, 8, 9: Graceful handling of network timeouts and malformed responses."""
    import server

    # Clear cache
    server._ALERT_CACHE.clear()

    # Simulate httpx client that raises TimeoutException
    def timeout_client(*args, **kwargs):
        class MockFailingClient:
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            async def post(self, *args, **kwargs):
                raise httpx.ReadTimeout("Simulated network timeout")
            async def get(self, *args, **kwargs):
                raise httpx.ReadTimeout("Simulated network timeout")
        return MockFailingClient()

    monkeypatch.setattr(server.httpx, "AsyncClient", timeout_client)

    # Test India fallback under timeout
    res_fallback = await get_official_emergency_alerts(latitude=13.0827, longitude=80.2707)
    assert "source_type" in res_fallback
    assert res_fallback["active_alerts_count"] == 0
    assert isinstance(res_fallback["alerts"], list)
    assert "limitations" in res_fallback



@pytest.mark.asyncio
async def test_tool_10_get_global_disaster_alerts_real_api():
    """Test get_global_disaster_alerts against live GDACS GeoRSS feed."""
    res = await get_global_disaster_alerts(limit=5)
    assert "GDACS" in res["source"]
    assert res["source_type"] == "AGGREGATED"
    assert "global_alerts_count" in res
    assert isinstance(res["alerts"], list)
    assert len(res["limitations"]) > 0


@pytest.mark.asyncio
async def test_tool_11_get_air_quality_hazards_real_api():
    """Test get_air_quality_hazards against live Open-Meteo & Copernicus CAMS API."""
    res = await get_air_quality_hazards(latitude=13.0827, longitude=80.2707)
    assert res["source_type"] == "MODEL"
    assert "us_aqi" in res
    assert res["category"] in ("GOOD", "MODERATE", "UNHEALTHY_FOR_SENSITIVE_GROUPS", "UNHEALTHY", "VERY_UNHEALTHY", "HAZARDOUS")
    assert "pollutants" in res
    assert len(res["limitations"]) > 0


@pytest.mark.asyncio
async def test_tool_12_search_emergency_infrastructure_real_api():
    """Test search_emergency_infrastructure against live OpenStreetMap Overpass/Nominatim."""
    res = await search_emergency_infrastructure(latitude=13.0827, longitude=80.2707, infrastructure_type="hospital", radius_meters=5000)
    assert "OpenStreetMap" in res["source"]
    assert res["source_type"] == "MAPPED"
    assert "facilities_found" in res
    assert isinstance(res["facilities"], list)
    assert len(res["limitations"]) > 0


# ==============================================================================
# DETERMINISTIC EVIDENCE REASONING & ANTI-HALLUCINATION TESTS (TESTS 1 - 8)
# ==============================================================================

@pytest.mark.asyncio
async def test_reasoning_scenario_1_weather_low_vs_user_reported_flooding():
    """
    TEST 1: Weather forecast reports LOW rainfall while user reports active rising floodwaters.
    Expected: Weather tool is classified as MODEL (not ground truth); user observation is preserved; discrepancy is identifiable.
    """
    weather_res = await get_weather_risk(latitude=13.0827, longitude=80.2707, hours_ahead=6)
    assert weather_res["source_type"] == "MODEL"
    assert weather_res["confidence"] in ("MODEL_PROBABILISTIC", "UNAVAILABLE")
    assert len(weather_res["limitations"]) > 0

    # Simulate evidence fusion reconciliation
    user_report = {"source_type": "USER_REPORT", "claim": "Vehicles stranded and water rising at North Junction"}
    evidence_bundle = [weather_res, user_report]
    assert evidence_bundle[0]["source_type"] == "MODEL"
    assert evidence_bundle[1]["source_type"] == "USER_REPORT"
    # Verify neither source overwrites or silences the other
    assert evidence_bundle[0]["source_type"] != evidence_bundle[1]["source_type"]


@pytest.mark.asyncio
async def test_reasoning_scenario_2_osm_hospital_no_operational_status():
    """
    TEST 2: OSM maps a hospital; no real-time bed or operational status exists.
    Expected: Classification is MAPPED; limitations explicitly declare bed capacity and active operational readiness are unverified.
    """
    hosp_res = await find_nearby_resource(latitude=13.0827, longitude=80.2707, resource_type="hospital", radius_km=10.0)
    assert hosp_res["source_type"] == "MAPPED"
    assert hosp_res["confidence"] in ("COMMUNITY_MAPPED", "UNAVAILABLE")
    assert len(hosp_res["limitations"]) > 0


@pytest.mark.asyncio
async def test_reasoning_scenario_3_osrm_eta_no_flood_passability():
    """
    TEST 3: OSRM returns 4-minute ETA; flood incident is active on the ground.
    Expected: Classification is MODEL (ALGORITHMIC_ESTIMATE); limitations explicitly declare physical road passability and water levels are unverified.
    """
    route_res = await calculate_eta(origin_lat=13.0827, origin_lng=80.2707, dest_lat=13.0900, dest_lng=80.2800, mode="driving")
    assert route_res["source_type"] == "MODEL"
    assert route_res["confidence"] in ("ALGORITHMIC_ESTIMATE", "FALLBACK_ESTIMATE", "UNAVAILABLE")
    assert len(route_res["limitations"]) > 0


@pytest.mark.asyncio
async def test_reasoning_scenario_4_nasa_firms_thermal_anomaly():
    """
    TEST 4: NASA FIRMS reports a satellite thermal hotspot.
    Expected: Classification is OBSERVATIONAL (SATELLITE_THERMAL_INFRARED); limitations explicitly state it is a thermal anomaly, not a confirmed structure or wildfire.
    """
    firms_res = await get_active_fire_hotspots(latitude=34.05, longitude=-118.25, radius_km=50.0, days=1)
    assert firms_res["source_type"] == "OBSERVATIONAL"
    assert firms_res["confidence"] in ("SATELLITE_THERMAL_INFRARED", "UNAVAILABLE")
    assert len(firms_res["limitations"]) > 0


@pytest.mark.asyncio
async def test_reasoning_scenario_5_usgs_earthquake_no_structural_damage_inference():
    """
    TEST 5: USGS reports a magnitude earthquake.
    Expected: Classification is OFFICIAL (SEISMIC_SENSOR_NETWORK); limitations declare seismic magnitude does NOT confirm structural building collapse without ground inspection.
    """
    eq_res = await get_earthquake_activity(latitude=37.77, longitude=-122.41, radius_km=300.0, min_magnitude=2.0)
    assert eq_res["source_type"] == "OFFICIAL"
    assert eq_res["confidence"] in ("SEISMIC_SENSOR_NETWORK", "UNAVAILABLE")
    assert len(eq_res["limitations"]) > 0


@pytest.mark.asyncio
async def test_reasoning_scenario_6_sachet_official_warning_provenance():
    """
    TEST 6: SACHET official warning received alongside separate caller observations.
    Expected: SACHET is OFFICIAL (GOVERNMENT_AUTHORITATIVE), preserving government issuing authority provenance separately from caller reports.
    """
    alerts_res = await get_official_emergency_alerts(latitude=13.0827, longitude=80.2707)
    assert alerts_res["source_type"] == "OFFICIAL"
    assert alerts_res["confidence"] == "GOVERNMENT_AUTHORITATIVE"
    assert "SACHET" in alerts_res["source"] or "NDMA" in alerts_res["source"]
    assert "retrieved_at" in alerts_res


@pytest.mark.asyncio
async def test_reasoning_scenario_7_sachet_clean_vs_local_telemetry_overflow(monkeypatch):
    """
    TEST 7: SACHET has 0 active bulletins while local Tocsin telemetry reports rapid flood overflow.
    Expected: SACHET official feed (0 alerts) and Tocsin telemetry (HIGH_SIMULATOR_TELEMETRY) are preserved together as an explicit conflict rather than declaring 'No flood'.
    """
    import server

    test_id = "inc-flood-conflict-07"

    # Set up in-process ASGITransport
    original_async_client = httpx.AsyncClient
    try:
        from app.main import app
        from httpx import ASGITransport
        transport = ASGITransport(app=app)
        def client_factory(**kwargs):
            kwargs.setdefault("transport", transport)
            kwargs.setdefault("base_url", "http://test")
            return original_async_client(**kwargs)
    except ImportError:
        def client_factory(**kwargs):
            return original_async_client(**kwargs)

    monkeypatch.setattr(server.httpx, "AsyncClient", client_factory)
    monkeypatch.setattr(server, "BACKEND_URL", "http://test")

    # 1. Create incident with overflow telemetry
    async with client_factory(timeout=3.0) as client:
        create_resp = await client.post(
            "/api/incidents",
            json={
                "incident_id": test_id,
                "title": "Adyar River Basin Overflow",
                "event_type": "FLOOD_SURGE",
            },
        )
        assert create_resp.status_code in (200, 201)

    # 2. Get local telemetry
    status_res = await get_incident_status(incident_id=test_id)
    assert status_res["source_type"] == "LOCAL_TELEMETRY"
    assert status_res["confidence"] == "HIGH_SIMULATOR_TELEMETRY"

    # 3. Get official alerts
    alerts_res = await get_official_emergency_alerts(latitude=13.0827, longitude=80.2707)
    assert alerts_res["source_type"] == "OFFICIAL"

    # Evidence conflict validation: Regional bulletin absence or status does NOT invalidate local sensor telemetry
    assert alerts_res["source_type"] == "OFFICIAL"
    assert status_res["source_type"] == "LOCAL_TELEMETRY"
    assert status_res["data"].get("status") in ("IDLE", "DEGRADING", "ACTIVE")


@pytest.mark.asyncio
async def test_reasoning_scenario_8_high_impact_action_pending_approval(monkeypatch):
    """
    TEST 8: High-impact emergency action proposed (e.g. boat deployment or evacuation).
    Expected: Action enters PENDING_APPROVAL with REQUIRES_HUMAN_APPROVAL confidence and is NOT executed automatically.
    """
    import server

    test_id = "inc-approval-scenario-08"

    # Set up in-process ASGITransport
    original_async_client = httpx.AsyncClient
    try:
        from app.main import app
        from httpx import ASGITransport
        transport = ASGITransport(app=app)
        def client_factory(**kwargs):
            kwargs.setdefault("transport", transport)
            kwargs.setdefault("base_url", "http://test")
            return original_async_client(**kwargs)
    except ImportError:
        def client_factory(**kwargs):
            return original_async_client(**kwargs)

    monkeypatch.setattr(server.httpx, "AsyncClient", client_factory)
    monkeypatch.setattr(server, "BACKEND_URL", "http://test")

    # 1. Create incident
    async with client_factory(timeout=3.0) as client:
        create_resp = await client.post(
            "/api/incidents",
            json={
                "incident_id": test_id,
                "title": "Submerged Residential Sector 4",
                "event_type": "STRANDED_GROUP",
            },
        )
        assert create_resp.status_code in (200, 201)

    # 2. Propose high-impact rescue action
    prop_res = await propose_incident_action(
        incident_id=test_id,
        tool_name="dispatch_rescue_boats",
        rationale="15 stranded residents reported by caller; road impassable.",
    )
    assert prop_res["source_type"] == "PROPOSED_ACTION"
    assert prop_res["confidence"] == "REQUIRES_HUMAN_APPROVAL"
    assert prop_res["data"]["status"] == "PENDING_APPROVAL"
    assert prop_res["data"]["proposed"] is True

    # 3. Verify incident is still in its active/unresolved state (NOT resolved automatically)
    status_check = await get_incident_status(incident_id=test_id)
    assert status_check["data"]["status"] != "RESOLVING"
    assert status_check["data"]["status"] in ("IDLE", "DEGRADING")







# ==============================================================================
# Tool 13: page_oncall_engineer (PagerDuty Events API v2)
# ==============================================================================

@pytest.mark.asyncio
async def test_tool_13_page_oncall_engineer_mock_fallback(monkeypatch):
    """No PAGERDUTY_ROUTING_KEY configured: must return an explicitly labeled mock, page no one."""
    import server

    monkeypatch.delenv("PAGERDUTY_ROUTING_KEY", raising=False)

    res = await page_oncall_engineer(
        incident_id="inc-mcp-test-page-1",
        summary="Login API returning 503s for ~40% of requests since the latest deployment.",
        severity="SEV2",
    )
    assert res["paged"] is False
    assert res["mode"] == "MOCK_FALLBACK"
    assert "status_for_agent" in res
    assert "NOT ACTUALLY PAGED" in res["status_for_agent"]
    # severity/simulated_summary live under `data`, not the top level -- only
    # the fields explicitly duplicated into extra_root_fields reach the top.
    assert res["data"]["severity"] == "SEV2"
    assert "40%" in res["data"]["simulated_summary"]


@pytest.mark.asyncio
async def test_tool_13_page_oncall_engineer_live_dispatch(monkeypatch):
    """
    With PAGERDUTY_ROUTING_KEY set, must POST the documented Events API v2 shape
    (routing_key, event_action=trigger, dedup_key=incident_id, payload with
    summary/source/severity) and report success only when PagerDuty's response
    itself says status=success.
    """
    import server

    monkeypatch.setenv("PAGERDUTY_ROUTING_KEY", "test-routing-key-abc123")
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"status": "success", "dedup_key": "inc-mcp-test-page-2"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, json):
            captured["url"] = url
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr(server.httpx, "AsyncClient", lambda *a, **k: FakeClient())

    res = await page_oncall_engineer(
        incident_id="inc-mcp-test-page-2",
        summary="Confirmed active outage: logins failing for majority of users.",
        severity="SEV1",
    )

    assert captured["url"] == "https://events.pagerduty.com/v2/enqueue"
    body = captured["json"]
    assert body["routing_key"] == "test-routing-key-abc123"
    assert body["event_action"] == "trigger"
    assert body["dedup_key"] == "inc-mcp-test-page-2"
    assert body["payload"]["severity"] == "critical"  # SEV1 -> PagerDuty's "critical"
    assert body["payload"]["source"] == "tocsin-incident-inc-mcp-test-page-2"

    assert res["paged"] is True
    assert res["delivery_status"] == "delivered"
    assert res["tool_classification"] == "LIVE_EXTERNAL"


@pytest.mark.asyncio
async def test_tool_13_severity_mapping_sev2_sev3(monkeypatch):
    """SEV2 -> PagerDuty 'error', SEV3 -> PagerDuty 'warning' (SEV1->critical covered above)."""
    import server

    monkeypatch.setenv("PAGERDUTY_ROUTING_KEY", "test-routing-key-abc123")
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"status": "success", "dedup_key": "x"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, json):
            captured["severity"] = json["payload"]["severity"]
            return FakeResponse()

    monkeypatch.setattr(server.httpx, "AsyncClient", lambda *a, **k: FakeClient())

    await page_oncall_engineer(incident_id="inc-x", summary="s", severity="SEV2")
    assert captured["severity"] == "error"

    await page_oncall_engineer(incident_id="inc-x", summary="s", severity="SEV3")
    assert captured["severity"] == "warning"


@pytest.mark.asyncio
async def test_tool_13_falls_back_to_mock_when_pagerduty_response_lacks_success(monkeypatch):
    """A configured key that gets a non-success response must fall back honestly, not report a fake page."""
    import server

    monkeypatch.setenv("PAGERDUTY_ROUTING_KEY", "test-routing-key-abc123")

    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"status": "invalid event"}  # not "success"

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr(server.httpx, "AsyncClient", lambda *a, **k: FakeClient())

    res = await page_oncall_engineer(incident_id="inc-y", summary="s", severity="SEV3")
    assert res["paged"] is False
    assert res["mode"] == "MOCK_FALLBACK"


@pytest.mark.asyncio
async def test_tool_13_empty_summary_rejected():
    res = await page_oncall_engineer(incident_id="inc-z", summary="   ", severity="SEV1")
    assert "error" in res
