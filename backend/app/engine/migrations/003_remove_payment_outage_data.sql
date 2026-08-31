-- 003_remove_payment_outage_data.sql
--
-- Removes stale PAYMENT_OUTAGE-scenario data left over from before the pivot to the
-- identity-outage presentation scenario (see CLAUDE.md: "Do not use a payment outage
-- anywhere in the demo or documentation"). The EventType enum in
-- backend/app/models/incident.py had PAYMENT_OUTAGE removed, but the already-persisted
-- 'inc-demo-payment-outage' row was never cleaned up — it was silently failing to
-- deserialize on every backend startup:
--
--   ERROR tocsin.repositories - Failed to deserialize incident row: 1 validation error
--   for IncidentState / event_type: Input should be 'WATER_CONTAMINATION', ... [type=
--   enum, input_value='PAYMENT_OUTAGE', ...]
--
-- Deleted rather than remapped to a valid enum value: this incident's title ("Major
-- Payment Processing & Checkout Outage") is itself payment-outage content, so
-- relabeling its event_type while keeping the row would still leave payment-outage
-- material reachable through the API. Delete children before the parent to satisfy
-- the FK constraints in 001_initial_schema.sql (no ON DELETE CASCADE is defined
-- there, so this must be done explicitly and in dependency order).
--
-- Written generally (matches on event_type, not a hardcoded incident_id) so it also
-- cleans up any other row that may have been created with the same stale value.

DELETE FROM conflicts
WHERE incident_id IN (SELECT incident_id FROM incidents WHERE event_type = 'PAYMENT_OUTAGE');

DELETE FROM claims
WHERE incident_id IN (SELECT incident_id FROM incidents WHERE event_type = 'PAYMENT_OUTAGE');

DELETE FROM observations
WHERE incident_id IN (SELECT incident_id FROM incidents WHERE event_type = 'PAYMENT_OUTAGE');

DELETE FROM missing_info
WHERE incident_id IN (SELECT incident_id FROM incidents WHERE event_type = 'PAYMENT_OUTAGE');

DELETE FROM unresolved_risks
WHERE incident_id IN (SELECT incident_id FROM incidents WHERE event_type = 'PAYMENT_OUTAGE');

DELETE FROM action_items
WHERE incident_id IN (SELECT incident_id FROM incidents WHERE event_type = 'PAYMENT_OUTAGE');

DELETE FROM action_audit_log
WHERE incident_id IN (SELECT incident_id FROM incidents WHERE event_type = 'PAYMENT_OUTAGE');

DELETE FROM proposed_actions
WHERE incident_id IN (SELECT incident_id FROM incidents WHERE event_type = 'PAYMENT_OUTAGE');

DELETE FROM timeline_entries
WHERE incident_id IN (SELECT incident_id FROM incidents WHERE event_type = 'PAYMENT_OUTAGE');

DELETE FROM incident_summaries
WHERE incident_id IN (SELECT incident_id FROM incidents WHERE event_type = 'PAYMENT_OUTAGE');

DELETE FROM participants
WHERE incident_id IN (SELECT incident_id FROM incidents WHERE event_type = 'PAYMENT_OUTAGE');

DELETE FROM incidents
WHERE event_type = 'PAYMENT_OUTAGE';
