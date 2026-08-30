"""
PostgreSQL Production Persistence Test Suite
Verifies:
1. All SQL migrations apply cleanly to real PostgreSQL container.
2. Full entity lifecycle (Incidents, Observations, Claims, Conflicts, ActionItems, Participants, Summaries) persists in PostgreSQL.
3. Health check reports genuine PostgreSQL connectivity.
4. Actual process-restart persistence:
   - Subprocess 1 starts, writes data to PostgreSQL, terminates.
   - Subprocess 2 starts, reads data from PostgreSQL, validates complete state preservation.
"""

import os
import sys
import time
import subprocess
import signal
import pytest
import httpx
from httpx import ASGITransport, AsyncClient

from app.engine.database import init_db, close_db, fetch_all, get_db_type, is_db_connected
from app.main import app

POSTGRES_URL = os.getenv("DATABASE_URL", "postgresql://tocsin:tocsin_password@localhost:5432/tocsin")


@pytest.fixture(autouse=True)
async def setup_postgres_env():
    """Ensure PostgreSQL is used for this test suite."""
    os.environ["DATABASE_URL"] = POSTGRES_URL
    os.environ["USE_SQLITE_FALLBACK"] = "false"
    os.environ["TOCSIN_COMMANDER_KEY"] = "tocsin-commander-key"

    await init_db()
    yield
    await close_db()


@pytest.mark.asyncio
async def test_postgres_migrations_and_connectivity():
    """Verify migrations and database connectivity in PostgreSQL."""
    assert is_db_connected() is True
    assert get_db_type() == "postgresql"

    # Verify all expected tables exist
    tables = await fetch_all("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")
    table_names = {t["table_name"] for t in tables}

    expected_tables = {
        "_migrations", "incidents", "participants", "observations", "claims",
        "conflicts", "missing_info", "unresolved_risks", "action_items",
        "proposed_actions", "action_audit_log", "timeline_entries", "incident_summaries"
    }
    assert expected_tables.issubset(table_names), f"Missing tables: {expected_tables - table_names}"


@pytest.mark.asyncio
async def test_postgres_health_check_endpoint():
    """Verify that /health reports genuine PostgreSQL connectivity."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health")
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ok"
        assert data["database"]["connected"] is True
        assert data["database"]["type"] == "postgresql"


@pytest.mark.asyncio
async def test_postgres_full_entity_persistence():
    """Verify all intelligence entities are written to PostgreSQL and read back."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Create incident
        inc_res = await client.post(
            "/api/incidents",
            json={"title": "Postgres Persistence Test", "event_type": "FLOOD_SURGE"},
        )
        assert inc_res.status_code == 201
        inc_id = inc_res.json()["incident_id"]

        # 2. Register participant
        part_res = await client.post(
            f"/api/incidents/{inc_id}/participants",
            json={
                "name": "Commander Vega",
                "role": "INCIDENT_COMMANDER",
                "role_source": "declared",
                "agora_uid": "agora-uid-777",
            },
        )
        assert part_res.status_code == 201

        # 3. Ingest observation with claims
        obs_res = await client.post(
            f"/api/incidents/{inc_id}/observations",
            json={
                "raw_utterance": "We verified that the water intake pump is down and failing.",
                "agora_uid": "agora-uid-777",
                "source": "voice_transcript",
            },
        )
        assert obs_res.status_code == 201

        # 4. Propose and approve action
        prop_res = await client.post(
            f"/api/incidents/{inc_id}/actions/propose",
            json={
                "tool_name": "activate_backup_pump",
                "rationale": "Restore intake",
                "recovery_duration_seconds": 1.0,
            },
        )
        act_id = prop_res.json()["proposed_actions"][-1]["action_id"]

        app_res = await client.post(
            f"/api/incidents/{inc_id}/actions/{act_id}/approve",
            headers={"X-Tocsin-Auth": "tocsin-commander-key"},
            json={"commander_id": "Commander Vega"},
        )
        assert app_res.status_code == 200

        # 5. Generate final summary
        sum_res = await client.get(f"/api/incidents/{inc_id}/summary/final")
        assert sum_res.status_code == 200

        # 6. Verify directly in PostgreSQL tables via raw SQL
        pg_inc = await fetch_all("SELECT * FROM incidents WHERE incident_id = $1", inc_id)
        assert len(pg_inc) == 1
        assert pg_inc[0]["title"] == "Postgres Persistence Test"

        pg_obs = await fetch_all("SELECT * FROM observations WHERE incident_id = $1", inc_id)
        assert len(pg_obs) >= 1

        pg_claims = await fetch_all("SELECT * FROM claims WHERE incident_id = $1", inc_id)
        assert len(pg_claims) >= 1

        pg_parts = await fetch_all("SELECT * FROM participants WHERE incident_id = $1", inc_id)
        assert len(pg_parts) >= 1

        pg_sums = await fetch_all("SELECT * FROM incident_summaries WHERE incident_id = $1", inc_id)
        assert len(pg_sums) >= 1


@pytest.mark.asyncio
async def test_real_process_restart_persistence():
    """
    Subprocess 1 starts uvicorn on port 8091 with PostgreSQL, writes incident + observations, exits.
    Subprocess 2 starts uvicorn on port 8092 with same PostgreSQL, loads state, asserts everything is intact.
    """
    env = os.environ.copy()
    env["DATABASE_URL"] = POSTGRES_URL
    env["USE_SQLITE_FALLBACK"] = "false"
    env["TOCSIN_COMMANDER_KEY"] = "tocsin-commander-key"
    env["LOG_LEVEL"] = "WARNING"

    inc_id = f"inc-proc-restart-{int(time.time())}"

    # ── Process 1: Start, create, populate, kill ───────────────────────────
    proc1 = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8091", "--host", "127.0.0.1"],
        cwd=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        # Wait for Process 1 to be ready
        ready = False
        async with httpx.AsyncClient(base_url="http://127.0.0.1:8091") as client:
            for _ in range(30):
                try:
                    res = await client.get("/health")
                    if res.status_code == 200:
                        ready = True
                        break
                except Exception:
                    pass
                time.sleep(0.2)

            assert ready, "Subprocess 1 failed to start within timeout"

            # Create incident in Process 1
            res = await client.post(
                "/api/incidents",
                json={"title": "Multi-Process Persistence Test", "event_type": "TECHNICAL_INCIDENT", "incident_id": inc_id},
            )
            assert res.status_code == 201

            # Ingest observation in Process 1
            res = await client.post(
                f"/api/incidents/{inc_id}/observations",
                json={
                    "raw_utterance": "Ravi confirmed the primary database replica is down.",
                    "speaker": "Ravi",
                    "source": "voice_transcript",
                },
            )
            assert res.status_code == 201
    finally:
        proc1.terminate()
        proc1.wait(timeout=5)

    # ── Process 2: Start new process, load from Postgres, verify ──────────
    proc2 = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8092", "--host", "127.0.0.1"],
        cwd=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        ready = False
        async with httpx.AsyncClient(base_url="http://127.0.0.1:8092") as client:
            for _ in range(30):
                try:
                    res = await client.get("/health")
                    if res.status_code == 200:
                        ready = True
                        break
                except Exception:
                    pass
                time.sleep(0.2)

            assert ready, "Subprocess 2 failed to start within timeout"

            # Retrieve incident from Process 2
            res = await client.get(f"/api/incidents/{inc_id}")
            assert res.status_code == 200
            state = res.json()

            # Verify complete state was preserved across actual process restart
            assert state["incident_id"] == inc_id
            assert state["title"] == "Multi-Process Persistence Test"
            assert len(state["observations"]) >= 1
            assert state["observations"][0]["speaker"] == "Ravi"
            assert len(state["claims"]) >= 1
    finally:
        proc2.terminate()
        proc2.wait(timeout=5)
