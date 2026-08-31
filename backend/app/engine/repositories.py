"""
Tocsin Repository Layer
Data access objects for all incident intelligence entities.
These repositories are the single source of truth for PostgreSQL/SQLite persistence.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any

from app.engine.database import execute, fetch_all, fetch_one, get_db_type, new_id, get_utc_now_str
from app.models.incident import (
    ActionItem,
    Claim,
    ClaimType,
    ConflictRecord,
    EvidenceStatus,
    ExtractionMethod,
    IncidentState,
    MissingInfo,
    Observation,
    ObservationCategory,
    Participant,
    ParticipantRole,
    ProposedAction,
    RoleSource,
    SeverityLevel,
    UnresolvedRisk,
)

logger = logging.getLogger("tocsin.repositories")


def _to_dt(val: str | datetime | None) -> datetime | None:
    """Safely convert ISO-8601 string or timestamp to datetime object for asyncpg/PostgreSQL."""
    if val is None:
        return None
    if isinstance(val, datetime):
        return val
    try:
        dt = datetime.fromisoformat(val)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return datetime.now(timezone.utc)


def _json_loads_safe(val: Any) -> Any:
    """Safely parse a JSON string, returning the original value if it's already parsed."""
    if val is None:
        return None
    if isinstance(val, (dict, list)):
        return val
    try:
        return json.loads(val)
    except (TypeError, ValueError):
        return val


# Tables whose rows may be closed via the shared evidence-resolution helper.
# Whitelisted because the table name is interpolated into SQL: only these three
# constants may ever reach that interpolation, never caller-supplied input.
_RESOLVABLE_EVIDENCE_TABLES = frozenset({"missing_info", "unresolved_risks"})


async def _resolve_evidence_row(
    table: str, row_id: str, resolved_by: str, resolution_notes: str, resolved_at: str
) -> None:
    """
    Mark an evidence row RESOLVED with human attribution.

    Shared by MissingInfoRepository and UnresolvedRiskRepository, which have identical
    resolution columns (added in migration 002). ConflictRepository has its own copy
    because its 001 schema already carried resolved_at/resolution_notes.
    """
    if table not in _RESOLVABLE_EVIDENCE_TABLES:
        raise ValueError(f"Refusing to resolve rows in non-whitelisted table: {table!r}")

    if get_db_type() == "postgresql":
        await execute(
            f"""
            UPDATE {table}
            SET status = 'RESOLVED', resolved_by = $2, resolution_notes = $3, resolved_at = $4
            WHERE id = $1
            """,
            row_id, resolved_by, resolution_notes, _to_dt(resolved_at),
        )
    else:
        await execute(
            f"""
            UPDATE {table}
            SET status = 'RESOLVED', resolved_by = ?, resolution_notes = ?, resolved_at = ?
            WHERE id = ?
            """,
            resolved_by, resolution_notes, resolved_at, row_id,
        )


# ─── Incident Repository ─────────────────────────────────────────────────────

class IncidentRepository:
    """CRUD for the incidents table. state_json stores full IncidentState snapshots."""

    async def upsert(self, state: IncidentState) -> None:
        """Insert or update an incident record with current state snapshot."""
        state_json = state.model_dump_json()
        if get_db_type() == "postgresql":
            await execute(
                """
                INSERT INTO incidents (incident_id, title, event_type, status, severity, created_at, updated_at, state_json)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
                ON CONFLICT (incident_id) DO UPDATE SET
                    title = EXCLUDED.title,
                    event_type = EXCLUDED.event_type,
                    status = EXCLUDED.status,
                    severity = EXCLUDED.severity,
                    updated_at = EXCLUDED.updated_at,
                    state_json = EXCLUDED.state_json
                """,
                state.incident_id,
                state.title,
                state.event_type.value,
                state.status.value,
                state.severity.value,
                _to_dt(state.created_at),
                _to_dt(state.updated_at),
                state_json,
            )
        else:
            await execute(
                """
                INSERT OR REPLACE INTO incidents (incident_id, title, event_type, status, severity, created_at, updated_at, state_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                state.incident_id,
                state.title,
                state.event_type.value,
                state.status.value,
                state.severity.value,
                state.created_at,
                state.updated_at,
                state_json,
            )

    async def get(self, incident_id: str) -> IncidentState | None:
        """Load full IncidentState from the database."""
        row = await fetch_one(
            "SELECT state_json FROM incidents WHERE incident_id = $1", incident_id
        )
        if not row:
            return None
        state_data = _json_loads_safe(row["state_json"])
        return IncidentState.model_validate(state_data)

    async def list_all(self) -> list[IncidentState]:
        """Load all persisted incidents."""
        rows = await fetch_all("SELECT state_json FROM incidents ORDER BY created_at DESC")
        incidents = []
        for r in rows:
            try:
                data = _json_loads_safe(r["state_json"])
                incidents.append(IncidentState.model_validate(data))
            except Exception as e:
                logger.error(f"Failed to deserialize incident row: {e}")
        return incidents

    async def delete(self, incident_id: str) -> None:
        await execute("DELETE FROM incidents WHERE incident_id = $1", incident_id)


# ─── Participant Repository ──────────────────────────────────────────────────

class ParticipantRepository:

    async def upsert(self, participant: Participant, incident_id: str) -> None:
        if get_db_type() == "postgresql":
            await execute(
                """
                INSERT INTO participants (id, incident_id, name, role, role_source, role_confidence, agora_uid, language, joined_at, last_active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    role = EXCLUDED.role,
                    role_source = EXCLUDED.role_source,
                    role_confidence = EXCLUDED.role_confidence,
                    agora_uid = EXCLUDED.agora_uid,
                    language = EXCLUDED.language,
                    last_active = EXCLUDED.last_active
                """,
                participant.id,
                incident_id,
                participant.name,
                participant.role.value if hasattr(participant.role, "value") else str(participant.role),
                participant.role_source.value if hasattr(participant.role_source, "value") else str(participant.role_source),
                participant.role_confidence,
                participant.agora_uid,
                participant.language,
                _to_dt(participant.joined_at),
                _to_dt(participant.last_active),
            )
        else:
            await execute(
                """
                INSERT OR REPLACE INTO participants (id, incident_id, name, role, role_source, role_confidence, agora_uid, language, joined_at, last_active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                participant.id,
                incident_id,
                participant.name,
                participant.role.value if hasattr(participant.role, "value") else str(participant.role),
                participant.role_source.value if hasattr(participant.role_source, "value") else str(participant.role_source),
                participant.role_confidence,
                participant.agora_uid,
                participant.language,
                participant.joined_at,
                participant.last_active,
            )

    async def find_by_agora_uid(self, incident_id: str, agora_uid: str) -> Participant | None:
        row = await fetch_one(
            "SELECT * FROM participants WHERE incident_id = $1 AND agora_uid = $2 LIMIT 1",
            incident_id, agora_uid,
        )
        if not row:
            return None
        return Participant(
            id=row["id"],
            name=row["name"],
            role=ParticipantRole(row["role"]),
            role_source=RoleSource(row["role_source"]),
            role_confidence=float(row["role_confidence"]),
            agora_uid=row["agora_uid"],
            language=row["language"],
            joined_at=str(row["joined_at"]),
            last_active=str(row["last_active"]),
        )

    async def list_by_incident(self, incident_id: str) -> list[Participant]:
        rows = await fetch_all(
            "SELECT * FROM participants WHERE incident_id = $1 ORDER BY joined_at",
            incident_id,
        )
        return [
            Participant(
                id=r["id"],
                name=r["name"],
                role=ParticipantRole(r["role"]),
                role_source=RoleSource(r["role_source"]),
                role_confidence=float(r["role_confidence"]),
                agora_uid=r["agora_uid"],
                language=r["language"],
                joined_at=str(r["joined_at"]),
                last_active=str(r["last_active"]),
            )
            for r in rows
        ]


# ─── Observation Repository ──────────────────────────────────────────────────

class ObservationRepository:

    async def insert(self, obs: Observation) -> None:
        evidence_json = json.dumps(obs.evidence_refs or [])
        if get_db_type() == "postgresql":
            await execute(
                """
                INSERT INTO observations
                (id, incident_id, raw_utterance, speaker, participant_id, source, category, status, content, confidence, evidence_refs, timestamp, extraction_method)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
                ON CONFLICT (id) DO NOTHING
                """,
                obs.id, obs.incident_id, obs.raw_utterance,
                obs.speaker, obs.participant_id, obs.source,
                obs.category.value if hasattr(obs.category, "value") else str(obs.category),
                obs.status.value if hasattr(obs.status, "value") else str(obs.status),
                obs.content, obs.confidence, evidence_json,
                _to_dt(obs.timestamp),
                obs.extraction_method.value if hasattr(obs.extraction_method, "value") else str(obs.extraction_method),
            )
        else:
            await execute(
                """
                INSERT OR IGNORE INTO observations
                (id, incident_id, raw_utterance, speaker, participant_id, source, category, status, content, confidence, evidence_refs, timestamp, extraction_method)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                obs.id, obs.incident_id, obs.raw_utterance,
                obs.speaker, obs.participant_id, obs.source,
                obs.category.value if hasattr(obs.category, "value") else str(obs.category),
                obs.status.value if hasattr(obs.status, "value") else str(obs.status),
                obs.content, obs.confidence, evidence_json,
                obs.timestamp,
                obs.extraction_method.value if hasattr(obs.extraction_method, "value") else str(obs.extraction_method),
            )

    async def exists_recent_duplicate(self, incident_id: str, content_hash: str) -> bool:
        """Check if an identical utterance was processed in the last 30 seconds."""
        if get_db_type() == "postgresql":
            row = await fetch_one(
                """
                SELECT 1 FROM observations
                WHERE incident_id = $1
                  AND raw_utterance = $2
                  AND timestamp > NOW() - INTERVAL '30 seconds'
                LIMIT 1
                """,
                incident_id, content_hash,
            )
        else:
            row = await fetch_one(
                """
                SELECT 1 FROM observations
                WHERE incident_id = ?
                  AND raw_utterance = ?
                  AND timestamp > datetime('now', '-30 seconds')
                LIMIT 1
                """,
                incident_id, content_hash,
            )
        return row is not None


# ─── Claim Repository ────────────────────────────────────────────────────────

class ClaimRepository:

    async def insert(self, claim: Claim) -> None:
        if get_db_type() == "postgresql":
            await execute(
                """
                INSERT INTO claims
                (id, observation_id, incident_id, claim_type, entity, value, speaker, source, timestamp, confidence, status, extraction_method)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (id) DO NOTHING
                """,
                claim.id, claim.observation_id, claim.incident_id,
                claim.claim_type.value if hasattr(claim.claim_type, "value") else str(claim.claim_type),
                claim.entity, claim.value,
                claim.speaker, claim.source,
                _to_dt(claim.timestamp),
                claim.confidence,
                claim.status.value if hasattr(claim.status, "value") else str(claim.status),
                claim.extraction_method.value if hasattr(claim.extraction_method, "value") else str(claim.extraction_method),
            )
        else:
            await execute(
                """
                INSERT OR IGNORE INTO claims
                (id, observation_id, incident_id, claim_type, entity, value, speaker, source, timestamp, confidence, status, extraction_method)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                claim.id, claim.observation_id, claim.incident_id,
                claim.claim_type.value if hasattr(claim.claim_type, "value") else str(claim.claim_type),
                claim.entity, claim.value,
                claim.speaker, claim.source, claim.timestamp,
                claim.confidence,
                claim.status.value if hasattr(claim.status, "value") else str(claim.status),
                claim.extraction_method.value if hasattr(claim.extraction_method, "value") else str(claim.extraction_method),
            )

    async def update_status(self, claim_id: str, status: EvidenceStatus) -> None:
        await execute(
            "UPDATE claims SET status = $1 WHERE id = $2",
            status.value if hasattr(status, "value") else str(status), claim_id,
        )

    async def find_by_entity(self, incident_id: str, entity: str) -> list[dict[str, Any]]:
        return await fetch_all(
            "SELECT * FROM claims WHERE incident_id = $1 AND entity = $2 ORDER BY timestamp",
            incident_id, entity,
        )


# ─── Conflict Repository ─────────────────────────────────────────────────────

class ConflictRepository:

    async def insert(self, conflict: ConflictRecord) -> None:
        if get_db_type() == "postgresql":
            await execute(
                """
                INSERT INTO conflicts
                (id, incident_id, claim_a_id, claim_b_id, entity, value_a, value_b, source_a, source_b, speaker_a, speaker_b, status, recommended_action, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                ON CONFLICT (id) DO NOTHING
                """,
                conflict.id, conflict.incident_id,
                conflict.claim_a_id, conflict.claim_b_id,
                conflict.entity, conflict.value_a, conflict.value_b,
                conflict.source_a, conflict.source_b,
                conflict.speaker_a, conflict.speaker_b,
                conflict.status.value if hasattr(conflict.status, "value") else str(conflict.status),
                conflict.recommended_action,
                _to_dt(conflict.created_at),
            )
        else:
            await execute(
                """
                INSERT OR IGNORE INTO conflicts
                (id, incident_id, claim_a_id, claim_b_id, entity, value_a, value_b, source_a, source_b, speaker_a, speaker_b, status, recommended_action, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                conflict.id, conflict.incident_id,
                conflict.claim_a_id, conflict.claim_b_id,
                conflict.entity, conflict.value_a, conflict.value_b,
                conflict.source_a, conflict.source_b,
                conflict.speaker_a, conflict.speaker_b,
                conflict.status.value if hasattr(conflict.status, "value") else str(conflict.status),
                conflict.recommended_action, conflict.created_at,
            )

    async def resolve(
        self, conflict_id: str, resolved_by: str, resolution_notes: str, resolved_at: str
    ) -> None:
        """Close a conflict with human attribution. Tocsin never self-resolves."""
        if get_db_type() == "postgresql":
            await execute(
                """
                UPDATE conflicts
                SET status = 'RESOLVED', resolved_by = $2, resolution_notes = $3, resolved_at = $4
                WHERE id = $1
                """,
                conflict_id, resolved_by, resolution_notes, _to_dt(resolved_at),
            )
        else:
            await execute(
                """
                UPDATE conflicts
                SET status = 'RESOLVED', resolved_by = ?, resolution_notes = ?, resolved_at = ?
                WHERE id = ?
                """,
                resolved_by, resolution_notes, resolved_at, conflict_id,
            )


# ─── ActionItem Repository ────────────────────────────────────────────────────

class ActionItemRepository:

    async def insert(self, item: ActionItem) -> None:
        if get_db_type() == "postgresql":
            await execute(
                """
                INSERT INTO action_items
                (id, incident_id, description, owner_name, owner_participant_id, status, created_at, due_at, source_utterance)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO NOTHING
                """,
                item.id, item.incident_id, item.description,
                item.owner_name, item.owner_participant_id, item.status,
                _to_dt(item.created_at),
                _to_dt(item.due_at),
                item.source_utterance,
            )
        else:
            await execute(
                """
                INSERT OR IGNORE INTO action_items
                (id, incident_id, description, owner_name, owner_participant_id, status, created_at, due_at, source_utterance)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                item.id, item.incident_id, item.description,
                item.owner_name, item.owner_participant_id, item.status,
                item.created_at, item.due_at, item.source_utterance,
            )

    async def update_status(self, item_id: str, status: str, completion_evidence: str | None = None, completed_at: str | None = None) -> None:
        if get_db_type() == "postgresql":
            await execute(
                "UPDATE action_items SET status = $1, completion_evidence = $2 WHERE id = $3",
                status, completion_evidence, item_id,
            )
        else:
            await execute(
                "UPDATE action_items SET status = ?, completion_evidence = ? WHERE id = ?",
                status, completion_evidence, item_id,
            )

    async def mark_overdue(self, item_id: str) -> None:
        await execute(
            "UPDATE action_items SET status = $1 WHERE id = $2",
            "OVERDUE", item_id,
        )

    async def update_reminder(self, item_id: str, reminder_time: str) -> None:
        if get_db_type() == "postgresql":
            await execute(
                "UPDATE action_items SET last_reminder_at = $1 WHERE id = $2",
                _to_dt(reminder_time), item_id,
            )
        else:
            await execute(
                "UPDATE action_items SET last_reminder_at = ? WHERE id = ?",
                reminder_time, item_id,
            )

    async def get_overdue(self, incident_id: str) -> list[dict[str, Any]]:
        if get_db_type() == "postgresql":
            return await fetch_all(
                """
                SELECT * FROM action_items
                WHERE incident_id = $1
                  AND status NOT IN ('COMPLETE', 'OVERDUE')
                  AND due_at IS NOT NULL
                  AND due_at < NOW()
                """,
                incident_id,
            )
        else:
            return await fetch_all(
                """
                SELECT * FROM action_items
                WHERE incident_id = ?
                  AND status NOT IN ('COMPLETE', 'OVERDUE')
                  AND due_at IS NOT NULL
                  AND due_at < datetime('now')
                """,
                incident_id,
            )


# ─── MissingInfo Repository ───────────────────────────────────────────────────

class MissingInfoRepository:

    async def insert(self, item: MissingInfo) -> None:
        if get_db_type() == "postgresql":
            await execute(
                """
                INSERT INTO missing_info (id, incident_id, description, recommended_action, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO NOTHING
                """,
                item.id, item.incident_id, item.description,
                item.recommended_action,
                item.status.value if hasattr(item.status, "value") else str(item.status),
                _to_dt(item.created_at),
            )
        else:
            await execute(
                """
                INSERT OR IGNORE INTO missing_info (id, incident_id, description, recommended_action, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                item.id, item.incident_id, item.description,
                item.recommended_action,
                item.status.value if hasattr(item.status, "value") else str(item.status),
                item.created_at,
            )

    async def resolve(
        self, info_id: str, resolved_by: str, resolution_notes: str, resolved_at: str
    ) -> None:
        """Close an information gap with the answer and who supplied it."""
        await _resolve_evidence_row("missing_info", info_id, resolved_by, resolution_notes, resolved_at)


# ─── UnresolvedRisk Repository ────────────────────────────────────────────────

class UnresolvedRiskRepository:

    async def insert(self, item: UnresolvedRisk) -> None:
        if get_db_type() == "postgresql":
            await execute(
                """
                INSERT INTO unresolved_risks (id, incident_id, description, severity, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO NOTHING
                """,
                item.id, item.incident_id, item.description,
                item.severity.value if hasattr(item.severity, "value") else str(item.severity),
                item.status.value if hasattr(item.status, "value") else str(item.status),
                _to_dt(item.created_at),
            )
        else:
            await execute(
                """
                INSERT OR IGNORE INTO unresolved_risks (id, incident_id, description, severity, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                item.id, item.incident_id, item.description,
                item.severity.value if hasattr(item.severity, "value") else str(item.severity),
                item.status.value if hasattr(item.status, "value") else str(item.status),
                item.created_at,
            )

    async def resolve(
        self, risk_id: str, resolved_by: str, resolution_notes: str, resolved_at: str
    ) -> None:
        """Close a risk with the mitigation or reasoning that retired it."""
        await _resolve_evidence_row("unresolved_risks", risk_id, resolved_by, resolution_notes, resolved_at)


# ─── Summary Repository ───────────────────────────────────────────────────────

class SummaryRepository:

    async def insert(self, incident_id: str, summary_type: str, content: str, generated_by: str = "SYSTEM") -> str:
        s_id = new_id("sum-")
        if get_db_type() == "postgresql":
            await execute(
                """
                INSERT INTO incident_summaries (id, incident_id, summary_type, content, generated_by, generated_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
                """,
                s_id, incident_id, summary_type, content, generated_by,
            )
        else:
            await execute(
                """
                INSERT INTO incident_summaries (id, incident_id, summary_type, content, generated_by, generated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
                """,
                s_id, incident_id, summary_type, content, generated_by,
            )
        return s_id

    async def get_latest(self, incident_id: str, summary_type: str = "final") -> dict[str, Any] | None:
        return await fetch_one(
            """
            SELECT * FROM incident_summaries
            WHERE incident_id = $1 AND summary_type = $2
            ORDER BY generated_at DESC
            LIMIT 1
            """,
            incident_id, summary_type,
        )


incident_repo = IncidentRepository()
participant_repo = ParticipantRepository()
observation_repo = ObservationRepository()
claim_repo = ClaimRepository()
conflict_repo = ConflictRepository()
action_item_repo = ActionItemRepository()
missing_info_repo = MissingInfoRepository()
risk_repo = UnresolvedRiskRepository()
summary_repo = SummaryRepository()
