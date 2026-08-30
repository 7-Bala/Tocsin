-- Tocsin Initial Schema Migration
-- Version: 001
-- Description: Creates all core tables for the incident intelligence system.

-- incidents: primary incident state + JSON snapshot for fast WS reads
CREATE TABLE IF NOT EXISTS incidents (
    incident_id     TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'IDLE',
    severity        TEXT NOT NULL DEFAULT 'LOW',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    state_json      JSONB NOT NULL DEFAULT '{}'
);

-- participants: named participants with role tracking
CREATE TABLE IF NOT EXISTS participants (
    id              TEXT PRIMARY KEY,
    incident_id     TEXT NOT NULL REFERENCES incidents(incident_id),
    name            TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'UNKNOWN',
    role_source     TEXT NOT NULL DEFAULT 'unknown',
    role_confidence REAL NOT NULL DEFAULT 0.0,
    agora_uid       TEXT,
    language        TEXT NOT NULL DEFAULT 'en',
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- observations: every ingested utterance
CREATE TABLE IF NOT EXISTS observations (
    id                TEXT PRIMARY KEY,
    incident_id       TEXT NOT NULL REFERENCES incidents(incident_id),
    raw_utterance     TEXT NOT NULL,
    speaker           TEXT,
    participant_id    TEXT,
    source            TEXT NOT NULL DEFAULT 'voice_transcript',
    category          TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
    status            TEXT NOT NULL DEFAULT 'UNVERIFIED',
    content           TEXT NOT NULL DEFAULT '',
    confidence        REAL NOT NULL DEFAULT 0.0,
    evidence_refs     JSONB NOT NULL DEFAULT '[]',
    timestamp         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    extraction_method TEXT NOT NULL DEFAULT 'llm'
);

-- claims: structured extracted claims from observations
CREATE TABLE IF NOT EXISTS claims (
    id              TEXT PRIMARY KEY,
    observation_id  TEXT NOT NULL REFERENCES observations(id),
    incident_id     TEXT NOT NULL REFERENCES incidents(incident_id),
    claim_type      TEXT NOT NULL DEFAULT 'other',
    entity          TEXT NOT NULL,
    value           TEXT NOT NULL,
    speaker         TEXT,
    source          TEXT NOT NULL DEFAULT 'voice_transcript',
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confidence      REAL NOT NULL DEFAULT 0.5,
    status          TEXT NOT NULL DEFAULT 'UNVERIFIED',
    extraction_method TEXT NOT NULL DEFAULT 'llm'
);

-- conflicts: detected claim conflicts
CREATE TABLE IF NOT EXISTS conflicts (
    id                  TEXT PRIMARY KEY,
    incident_id         TEXT NOT NULL REFERENCES incidents(incident_id),
    claim_a_id          TEXT NOT NULL REFERENCES claims(id),
    claim_b_id          TEXT NOT NULL REFERENCES claims(id),
    entity              TEXT NOT NULL,
    value_a             TEXT NOT NULL,
    value_b             TEXT NOT NULL,
    source_a            TEXT NOT NULL,
    source_b            TEXT NOT NULL,
    speaker_a           TEXT,
    speaker_b           TEXT,
    status              TEXT NOT NULL DEFAULT 'OPEN',
    recommended_action  TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ,
    resolution_notes    TEXT
);

-- missing_info: information gaps
CREATE TABLE IF NOT EXISTS missing_info (
    id                  TEXT PRIMARY KEY,
    incident_id         TEXT NOT NULL REFERENCES incidents(incident_id),
    description         TEXT NOT NULL,
    recommended_action  TEXT,
    status              TEXT NOT NULL DEFAULT 'OPEN',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- unresolved_risks: risks requiring attention
CREATE TABLE IF NOT EXISTS unresolved_risks (
    id              TEXT PRIMARY KEY,
    incident_id     TEXT NOT NULL REFERENCES incidents(incident_id),
    description     TEXT NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'MEDIUM',
    status          TEXT NOT NULL DEFAULT 'OPEN',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- action_items: task tracking with ownership and follow-up
CREATE TABLE IF NOT EXISTS action_items (
    id                      TEXT PRIMARY KEY,
    incident_id             TEXT NOT NULL REFERENCES incidents(incident_id),
    description             TEXT NOT NULL,
    owner_name              TEXT,
    owner_participant_id    TEXT,
    status                  TEXT NOT NULL DEFAULT 'OPEN',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_at                  TIMESTAMPTZ,
    follow_up_at            TIMESTAMPTZ,
    source_utterance        TEXT,
    blocking_reason         TEXT,
    last_reminder_at        TIMESTAMPTZ,
    completion_evidence     TEXT
);

-- proposed_actions: AI-proposed critical actions pending commander approval
-- PENDING_APPROVAL → APPROVED → EXECUTING → VERIFIED | FAILED
-- REJECTED is terminal
CREATE TABLE IF NOT EXISTS proposed_actions (
    action_id               TEXT PRIMARY KEY,
    incident_id             TEXT NOT NULL REFERENCES incidents(incident_id),
    tool_name               TEXT NOT NULL,
    parameters              JSONB NOT NULL DEFAULT '{}',
    rationale               TEXT NOT NULL,
    proposed_by             TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pending_at              TIMESTAMPTZ,
    approved_by             TEXT,
    approved_at             TIMESTAMPTZ,
    approval_notes          TEXT,
    rejection_reason        TEXT,
    rejected_by             TEXT,
    rejected_at             TIMESTAMPTZ,
    executed_at             TIMESTAMPTZ,
    verified_at             TIMESTAMPTZ,
    verification_result     TEXT,
    failed_at               TIMESTAMPTZ,
    failure_reason          TEXT,
    recovery_duration_seconds REAL DEFAULT 5.0,
    idempotency_key         TEXT UNIQUE
);

-- action_audit_log: immutable log of every state transition
CREATE TABLE IF NOT EXISTS action_audit_log (
    id                  SERIAL PRIMARY KEY,
    incident_id         TEXT NOT NULL,
    action_id           TEXT NOT NULL,
    from_status         TEXT NOT NULL,
    to_status           TEXT NOT NULL,
    actor               TEXT NOT NULL,
    notes               TEXT,
    parameters_snapshot JSONB,
    timestamp           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- timeline_entries: persistent timeline events
CREATE TABLE IF NOT EXISTS timeline_entries (
    id              SERIAL PRIMARY KEY,
    incident_id     TEXT NOT NULL REFERENCES incidents(incident_id),
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type      TEXT NOT NULL,
    description     TEXT NOT NULL,
    actor           TEXT NOT NULL DEFAULT 'SYSTEM',
    metadata        JSONB NOT NULL DEFAULT '{}'
);

-- incident_summaries: spoken and final summaries
CREATE TABLE IF NOT EXISTS incident_summaries (
    id              TEXT PRIMARY KEY,
    incident_id     TEXT NOT NULL REFERENCES incidents(incident_id),
    summary_type    TEXT NOT NULL DEFAULT 'final',
    content         TEXT NOT NULL,
    generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_by    TEXT NOT NULL DEFAULT 'SYSTEM'
);

-- indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_observations_incident ON observations(incident_id);
CREATE INDEX IF NOT EXISTS idx_claims_incident ON claims(incident_id);
CREATE INDEX IF NOT EXISTS idx_claims_entity ON claims(entity);
CREATE INDEX IF NOT EXISTS idx_conflicts_incident ON conflicts(incident_id);
CREATE INDEX IF NOT EXISTS idx_action_items_incident ON action_items(incident_id);
CREATE INDEX IF NOT EXISTS idx_proposed_actions_incident ON proposed_actions(incident_id);
CREATE INDEX IF NOT EXISTS idx_participants_incident ON participants(incident_id);
CREATE INDEX IF NOT EXISTS idx_timeline_incident ON timeline_entries(incident_id);
