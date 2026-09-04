"""Global pytest configuration and fixtures for Tocsin backend tests."""

import os
import tempfile
import pytest

from app.engine.database import init_db, close_db
from app.engine.simulator import simulator


@pytest.fixture(autouse=True)
async def setup_test_env():
    """Ensure clean test environment, isolated temporary database, and clean simulator state."""
    # Use temporary file for SQLite if fallback is enabled
    temp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    temp_db_path = temp_db.name
    temp_db.close()

    os.environ["SQLITE_DB_PATH"] = temp_db_path
    # Force SQLite isolation unconditionally — do NOT fall back to whatever the
    # environment already has. `app/main.py` calls load_dotenv() at import time, which
    # loads backend/.env (real dev config: USE_SQLITE_FALLBACK=false, DATABASE_URL
    # pointing at the real Postgres instance) *before* this fixture ever runs. The
    # previous `os.getenv("USE_SQLITE_FALLBACK", "true")` only supplies "true" when the
    # var is unset — it silently preserved the dotenv-loaded "false" instead, so every
    # local test run was actually hitting the real shared database. This was confirmed
    # live 2026-08-31: the incident count in dev Postgres grew from 149 to 222 rows
    # across a handful of local pytest runs. Tests that genuinely need real Postgres
    # (test_postgresql_live.py) already force it back via their own autouse fixture,
    # which runs after this one and is unaffected by this change.
    os.environ["USE_SQLITE_FALLBACK"] = "true"
    # Same failure mode as USE_SQLITE_FALLBACK above, and for the same reason:
    # `os.getenv(KEY, default)` only supplies the default when the var is UNSET, so
    # once backend/.env defines a real TOCSIN_COMMANDER_KEY (as a correctly
    # configured deployment must), load_dotenv() at import time wins and this
    # fixture silently adopts the developer's real secret. Every test that sends
    # the literal "tocsin-commander-key" header then 403s. That made the suite's
    # result depend on the developer's machine rather than on the code — it passed
    # only while the key happened to be unconfigured. Pinning it unconditionally
    # makes the suite hermetic. Tests needing other values (see
    # test_security_and_state_machine.py) override per-test via monkeypatch, which
    # runs after this fixture and restores cleanly.
    os.environ["TOCSIN_COMMANDER_KEY"] = "tocsin-commander-key"

    try:
        await init_db()
    except Exception:
        pass

    yield

    try:
        await simulator.shutdown()
        simulator._incidents.clear()
        await close_db()
    except Exception:
        pass

    if os.path.exists(temp_db_path):
        try:
            os.remove(temp_db_path)
        except OSError:
            pass
