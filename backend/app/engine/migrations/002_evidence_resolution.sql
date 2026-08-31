-- 002_evidence_resolution.sql
-- Adds human-attributed resolution to evidence-record items.
--
-- Rationale: conflicts, information gaps, and risks were detectable but not closable.
-- The `conflicts` table already carried resolved_at / resolution_notes with no code
-- path writing them, so an incident room could raise a contradiction but never settle
-- it. An evidence record that cannot be closed becomes misleading about what is still
-- open. Resolution is deliberately human-attributed: the AI detects, a named person
-- resolves.

-- conflicts: resolved_at / resolution_notes already exist in 001; add the resolver.
ALTER TABLE conflicts ADD COLUMN IF NOT EXISTS resolved_by TEXT;

-- missing_info: full resolution triple.
ALTER TABLE missing_info ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE missing_info ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE missing_info ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

-- unresolved_risks: full resolution triple.
ALTER TABLE unresolved_risks ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE unresolved_risks ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE unresolved_risks ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

-- Indexes for the "what is still open?" query that drives handoff briefs and
-- final summaries.
CREATE INDEX IF NOT EXISTS idx_conflicts_open ON conflicts (incident_id, status);
CREATE INDEX IF NOT EXISTS idx_missing_info_open ON missing_info (incident_id, status);
CREATE INDEX IF NOT EXISTS idx_risks_open ON unresolved_risks (incident_id, status);
