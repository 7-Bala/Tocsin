-- cleanup_test_incidents.sql
--
-- One-time (and reusable) manual cleanup for incidents accumulated by test runs
-- against the real dev Postgres database. NOT run automatically by migrations or by
-- pytest — this is deliberately a manual script, run by a human, because deleting
-- incident data should never happen as a side effect of an automated process that
-- could misfire against the wrong database.
--
-- Root cause of the accumulation (fixed 2026-08-31, see backend/tests/conftest.py):
-- the test suite's isolation fixture was silently overridden by dotenv-loaded dev
-- config, so most test runs were hitting this real database instead of an isolated
-- SQLite temp file. That leak is now closed; this script clears out what already
-- accumulated before the fix.
--
-- Usage:
--   docker compose exec -T postgres psql -U tocsin -d tocsin -f /path/to/this/file
--   (or paste the DELETE statements directly into psql)
--
-- Protects exactly one row: 'inc-demo-identity-outage', the canonical demo incident.
-- Everything else is deleted, in FK dependency order (no ON DELETE CASCADE is
-- defined in the schema, so this must be explicit).

DELETE FROM conflicts        WHERE incident_id <> 'inc-demo-identity-outage';
DELETE FROM claims           WHERE incident_id <> 'inc-demo-identity-outage';
DELETE FROM observations     WHERE incident_id <> 'inc-demo-identity-outage';
DELETE FROM missing_info     WHERE incident_id <> 'inc-demo-identity-outage';
DELETE FROM unresolved_risks WHERE incident_id <> 'inc-demo-identity-outage';
DELETE FROM action_items     WHERE incident_id <> 'inc-demo-identity-outage';
DELETE FROM action_audit_log WHERE incident_id <> 'inc-demo-identity-outage';
DELETE FROM proposed_actions WHERE incident_id <> 'inc-demo-identity-outage';
DELETE FROM timeline_entries WHERE incident_id <> 'inc-demo-identity-outage';
DELETE FROM incident_summaries WHERE incident_id <> 'inc-demo-identity-outage';
DELETE FROM participants     WHERE incident_id <> 'inc-demo-identity-outage';
DELETE FROM incidents        WHERE incident_id <> 'inc-demo-identity-outage';
