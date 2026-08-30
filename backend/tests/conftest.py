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
    os.environ["USE_SQLITE_FALLBACK"] = os.getenv("USE_SQLITE_FALLBACK", "true")
    os.environ["TOCSIN_COMMANDER_KEY"] = os.getenv("TOCSIN_COMMANDER_KEY", "tocsin-commander-key")

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
