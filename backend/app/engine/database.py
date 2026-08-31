"""
Tocsin Database Layer
Manages PostgreSQL connection pool, migrations, and SQLite fallback for local dev.

Persistence hierarchy:
  1. PRIMARY: PostgreSQL (asyncpg) — required in production
  2. FALLBACK: SQLite via aiosqlite — only when USE_SQLITE_FALLBACK=true and PostgreSQL unreachable

The backend fails to start if neither is available.
"""

import json
import logging
import os
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("tocsin.database")

# Will be set to an asyncpg pool or an aiosqlite connection path
_pool: Any = None
_db_type: str = "none"


def get_utc_now_str() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── Migration Runner ────────────────────────────────────────────────────────

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


async def _run_postgres_migrations(conn: Any) -> None:
    """Run all pending SQL migrations in order against PostgreSQL."""
    # Create migration tracking table
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS _migrations (
            version     TEXT PRIMARY KEY,
            applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)

    applied = {row["version"] for row in await conn.fetch("SELECT version FROM _migrations")}

    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    for mf in migration_files:
        version = mf.stem  # e.g. "001_initial_schema"
        if version not in applied:
            logger.info(f"Applying migration: {version}")
            sql = mf.read_text()
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute(
                    "INSERT INTO _migrations (version) VALUES ($1)", version
                )
            logger.info(f"Migration {version} applied.")
        else:
            logger.debug(f"Migration {version} already applied, skipping.")


async def _run_sqlite_migrations(conn: Any) -> None:
    """Run SQL migrations adapted for SQLite (strips PostgreSQL-specific syntax)."""
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS _migrations (
            version     TEXT PRIMARY KEY,
            applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    await conn.commit()

    async with conn.execute("SELECT version FROM _migrations") as cursor:
        applied = {row[0] for row in await cursor.fetchall()}

    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    for mf in migration_files:
        version = mf.stem
        if version not in applied:
            logger.info(f"Applying SQLite migration: {version}")
            sql = mf.read_text()
            # Adapt PostgreSQL syntax to SQLite
            sql = _adapt_sql_for_sqlite(sql)
            for statement in _split_sql(sql):
                if statement.strip():
                    try:
                        await conn.execute(statement)
                    except Exception as e:
                        logger.warning(f"SQLite migration statement warning: {e}\nSQL: {statement[:100]}")
            await conn.execute(
                "INSERT INTO _migrations (version) VALUES (?)", (version,)
            )
            await conn.commit()
            logger.info(f"SQLite migration {version} applied.")
        else:
            logger.debug(f"Migration {version} already applied, skipping.")


def _adapt_sql_for_sqlite(sql: str) -> str:
    """Convert PostgreSQL-specific syntax to SQLite-compatible SQL."""
    # TIMESTAMPTZ → TEXT
    sql = re.sub(r"\bTIMESTAMPTZ\b", "TEXT", sql, flags=re.IGNORECASE)
    # JSONB → TEXT
    sql = re.sub(r"\bJSONB\b", "TEXT", sql, flags=re.IGNORECASE)
    # SERIAL → INTEGER
    sql = re.sub(r"\bSERIAL\b", "INTEGER", sql, flags=re.IGNORECASE)
    # Remove REFERENCES constraints (SQLite has limited FK support by default)
    sql = re.sub(r"\s+REFERENCES\s+\w+\s*\(\w+\)", "", sql, flags=re.IGNORECASE)
    # SQLite does not allow function calls with parentheses in DEFAULT clauses.
    # CURRENT_TIMESTAMP is portable and valid in SQLite table definitions.
    sql = re.sub(r"\bNOW\(\)", "CURRENT_TIMESTAMP", sql, flags=re.IGNORECASE)
    # DEFAULT '{}' and DEFAULT '[]' are fine in SQLite
    return sql


def _split_sql(sql: str) -> list[str]:
    """Split a SQL file into individual statements."""
    return [s.strip() for s in sql.split(";") if s.strip()]


# ─── Pool Initialization ─────────────────────────────────────────────────────

async def init_db() -> None:
    """
    Initialize database connection.
    1. If USE_SQLITE_FALLBACK=true, use SQLite directly — do NOT attempt PostgreSQL
       first. This flag is an explicit instruction ("use sqlite"), not merely a
       last-resort safety net for when Postgres happens to be unreachable.
    2. Otherwise, try PostgreSQL (asyncpg).
    3. If both fail, raise RuntimeError.
    """
    global _pool, _db_type

    database_url = os.getenv("DATABASE_URL", "")
    use_sqlite_fallback = os.getenv("USE_SQLITE_FALLBACK", "false").lower() == "true"

    # Bug fixed 2026-08-31: this function used to try PostgreSQL first whenever
    # DATABASE_URL was set, regardless of USE_SQLITE_FALLBACK, only falling through
    # to SQLite if the Postgres *connection attempt itself* threw. Whenever the dev
    # Postgres container happened to be reachable (the common case locally), every
    # test run silently connected to and wrote into the real database anyway,
    # ignoring USE_SQLITE_FALLBACK entirely — confirmed live: 330 test-created rows
    # had accumulated in the real incidents table. An earlier fix that forced
    # USE_SQLITE_FALLBACK=true in tests/conftest.py addressed only half the bug; it
    # had no effect once Postgres was actually up, which was true for nearly this
    # entire session. Checking use_sqlite_fallback FIRST, before ever attempting
    # Postgres, is what actually makes the flag authoritative.
    attempt_postgres_first = bool(database_url) and not use_sqlite_fallback

    if attempt_postgres_first:
        # Try primary URL first
        urls_to_try = [database_url]
        if "@postgres:" in database_url:
            urls_to_try.append(database_url.replace("@postgres:", "@127.0.0.1:"))

        for url in urls_to_try:
            try:
                import asyncpg
                logger.info(f"Connecting to PostgreSQL: {_mask_url(url)}")
                pool = await asyncpg.create_pool(
                    url,
                    min_size=2,
                    max_size=10,
                    command_timeout=30,
                )
                async with pool.acquire() as conn:
                    await _run_postgres_migrations(conn)
                _pool = pool
                _db_type = "postgresql"
                logger.info("PostgreSQL connection pool initialized.")
                return
            except Exception as e:
                logger.debug(f"PostgreSQL connection attempt failed for {_mask_url(url)}: {e}")

        raise RuntimeError(
            "PostgreSQL is required but unavailable. Set USE_SQLITE_FALLBACK=true to use SQLite for local development."
        )

    if use_sqlite_fallback or not database_url:
        if use_sqlite_fallback and database_url:
            logger.warning("Using SQLite (USE_SQLITE_FALLBACK=true) — PostgreSQL was not attempted.")
        try:
            import aiosqlite  # type: ignore
            db_path = os.getenv("SQLITE_DB_PATH", "./tocsin_dev.db")
            logger.warning(
                f"[LOCAL DEV] Using SQLite at {db_path}. "
                "This is NOT suitable for production. Set DATABASE_URL to use PostgreSQL."
            )
            conn = await aiosqlite.connect(db_path)
            conn.row_factory = aiosqlite.Row
            await _run_sqlite_migrations(conn)
            _pool = conn
            _db_type = "sqlite"
            logger.info("SQLite connection initialized for local development.")
            return
        except ImportError:
            logger.error("aiosqlite not installed. Install it for SQLite fallback: pip install aiosqlite")
        except Exception as e:
            logger.error(f"SQLite initialization failed: {e}")

    raise RuntimeError(
        "No database backend could be initialized. "
        "Set DATABASE_URL for PostgreSQL or USE_SQLITE_FALLBACK=true for SQLite."
    )


async def close_db() -> None:
    """Close the database connection pool."""
    global _pool, _db_type
    if _pool is not None:
        try:
            if _db_type == "postgresql":
                await _pool.close()
            elif _db_type == "sqlite":
                await _pool.close()
            logger.info(f"Database connection ({_db_type}) closed.")
        except Exception as e:
            logger.error(f"Error closing database: {e}")
        _pool = None
        _db_type = "none"


def get_db_type() -> str:
    return _db_type


def is_db_connected() -> bool:
    return _pool is not None and _db_type != "none"


# ─── Query Execution ─────────────────────────────────────────────────────────

@asynccontextmanager
async def get_connection():
    """Context manager that yields a database connection."""
    if _pool is None:
        raise RuntimeError("Database not initialized. Call init_db() first.")

    if _db_type == "postgresql":
        async with _pool.acquire() as conn:
            yield conn
    elif _db_type == "sqlite":
        # SQLite uses a single persistent connection for dev
        yield _pool
    else:
        raise RuntimeError(f"Unknown db_type: {_db_type}")


async def execute(sql: str, *args: Any) -> None:
    """Execute a write statement."""
    async with get_connection() as conn:
        if _db_type == "postgresql":
            await conn.execute(sql, *args)
        else:
            sqlite_sql, sqlite_args = _pg_to_sqlite_query(sql, args)
            await conn.execute(sqlite_sql, sqlite_args)
            await conn.commit()


async def fetch_one(sql: str, *args: Any) -> dict[str, Any] | None:
    """Fetch a single row as a dict."""
    async with get_connection() as conn:
        if _db_type == "postgresql":
            row = await conn.fetchrow(sql, *args)
            return dict(row) if row else None
        else:
            sqlite_sql, sqlite_args = _pg_to_sqlite_query(sql, args)
            async with conn.execute(sqlite_sql, sqlite_args) as cursor:
                row = await cursor.fetchone()
                if row is None:
                    return None
                return dict(zip([d[0] for d in cursor.description], row))


async def fetch_all(sql: str, *args: Any) -> list[dict[str, Any]]:
    """Fetch all rows as a list of dicts."""
    async with get_connection() as conn:
        if _db_type == "postgresql":
            rows = await conn.fetch(sql, *args)
            return [dict(r) for r in rows]
        else:
            sqlite_sql, sqlite_args = _pg_to_sqlite_query(sql, args)
            async with conn.execute(sqlite_sql, sqlite_args) as cursor:
                rows = await cursor.fetchall()
                cols = [d[0] for d in cursor.description]
                return [dict(zip(cols, row)) for row in rows]


def _pg_to_sqlite_query(sql: str, args: tuple) -> tuple[str, list]:
    """Convert PostgreSQL $1, $2... placeholders to SQLite ? placeholders."""
    converted = re.sub(r"\$\d+", "?", sql)
    # Serialize any dict/list args to JSON strings for JSONB → TEXT columns
    converted_args = []
    for arg in args:
        if isinstance(arg, (dict, list)):
            converted_args.append(json.dumps(arg))
        else:
            converted_args.append(arg)
    return converted, converted_args


def _mask_url(url: str) -> str:
    """Mask credentials in database URL for safe logging."""
    return re.sub(r":[^:@]+@", ":***@", url)


def new_id(prefix: str = "") -> str:
    """Generate a new unique ID with optional prefix."""
    uid = uuid.uuid4().hex[:12]
    return f"{prefix}{uid}" if prefix else uid
