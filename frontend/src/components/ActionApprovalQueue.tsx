'use client';

import React, { useState } from 'react';
import {
  ActionApprovalStatus,
  IncidentState,
  ProposedAction,
} from '@/types/incident';
import {
  approveIncidentAction,
  DEFAULT_COMMANDER_KEY,
  proposeIncidentAction,
  rejectIncidentAction,
} from '@/hooks/useIncidentApi';

interface ActionApprovalQueueProps {
  incident: IncidentState | null;
  onActionProcessed: (updated: IncidentState) => void;
}

export const ActionApprovalQueue: React.FC<ActionApprovalQueueProps> = ({
  incident,
  onActionProcessed,
}) => {
  const [commanderKey, setCommanderKey] = useState(DEFAULT_COMMANDER_KEY);
  const [selectedAction, setSelectedAction] = useState<ProposedAction | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [actionNotes, setActionNotes] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Manual Proposal Modal state
  const [showProposeModal, setShowProposeModal] = useState(false);
  const [propToolName, setPropToolName] = useState('deploy_mobile_water_purification');
  const [propRationale, setPropRationale] = useState('');
  const [propRecoverySec, setPropRecoverySec] = useState(4);

  const proposedActions = incident?.proposed_actions || [];
  const pendingActions = proposedActions.filter(
    (a) => a.status === 'PENDING_APPROVAL'
  );
  const historicalActions = proposedActions.filter(
    (a) => a.status !== 'PENDING_APPROVAL'
  );

  const getStatusStyle = (status: ActionApprovalStatus) => {
    switch (status) {
      case 'PENDING_APPROVAL':
        return {
          bg: 'rgba(227, 179, 65, 0.15)',
          border: '#e3b341',
          color: '#e3b341',
          text: '⏳ PENDING APPROVAL',
        };
      case 'APPROVED':
      case 'EXECUTING':
        return {
          bg: 'rgba(88, 166, 255, 0.15)',
          border: '#58a6ff',
          color: '#58a6ff',
          text: '⚡ EXECUTING',
        };
      case 'VERIFIED':
        return {
          bg: 'rgba(63, 185, 80, 0.15)',
          border: '#3fb950',
          color: '#3fb950',
          text: '✓ VERIFIED / STABILIZED',
        };
      case 'REJECTED':
        return {
          bg: 'rgba(248, 81, 73, 0.15)',
          border: '#f85149',
          color: '#f85149',
          text: '✕ REJECTED',
        };
      default:
        return {
          bg: 'rgba(110, 118, 129, 0.15)',
          border: '#6e7681',
          color: '#adbac7',
          text: status,
        };
    }
  };

  const handleApprove = async (action: ProposedAction) => {
    if (!incident) return;
    setIsProcessing(true);
    setErrorMsg(null);
    try {
      const updated = await approveIncidentAction(
        incident.incident_id,
        action.action_id,
        {
          commander_id: 'Commander-Alpha',
          notes: actionNotes.trim() || undefined,
        },
        commanderKey
      );
      onActionProcessed(updated);
      setSelectedAction(null);
      setActionNotes('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to approve action');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReject = async (action: ProposedAction) => {
    if (!incident || !rejectReason.trim()) return;
    setIsProcessing(true);
    setErrorMsg(null);
    try {
      const updated = await rejectIncidentAction(
        incident.incident_id,
        action.action_id,
        {
          commander_id: 'Commander-Alpha',
          reason: rejectReason.trim(),
        },
        commanderKey
      );
      onActionProcessed(updated);
      setSelectedAction(null);
      setRejectReason('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to reject action');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCreateProposal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!incident || !propRationale.trim()) return;
    setIsProcessing(true);
    setErrorMsg(null);
    try {
      const updated = await proposeIncidentAction(incident.incident_id, {
        tool_name: propToolName,
        rationale: propRationale.trim(),
        recovery_duration_seconds: propRecoverySec,
        proposed_by: 'IncidentCommanderConsole',
      });
      onActionProcessed(updated);
      setShowProposeModal(false);
      setPropRationale('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to propose action');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <section
      aria-label="Human-in-the-Loop Action Approval Queue"
      style={{
        padding: '1.25rem',
        backgroundColor: 'var(--card-bg)',
        border: '1px solid var(--border)',
        borderRadius: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>🛡️ Action Approvals & Verification</span>
            {pendingActions.length > 0 && (
              <span
                style={{
                  fontSize: '0.75rem',
                  padding: '0.15rem 0.5rem',
                  borderRadius: '999px',
                  backgroundColor: '#f85149',
                  color: '#fff',
                  fontWeight: 700,
                }}
              >
                {pendingActions.length} Pending
              </span>
            )}
          </h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            High-impact emergency tools proposed by Voice AI / Responders require human authorization before execution.
          </p>
        </div>

        <button
          onClick={() => setShowProposeModal(true)}
          disabled={!incident}
          style={{
            padding: '0.45rem 0.85rem',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            backgroundColor: '#21262d',
            color: 'var(--text-primary)',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: incident ? 'pointer' : 'not-allowed',
          }}
        >
          + Propose Action
        </button>
      </div>

      {errorMsg && (
        <div style={{ padding: '0.65rem 0.85rem', borderRadius: '6px', backgroundColor: 'rgba(248, 81, 73, 0.15)', border: '1px solid #f85149', color: '#f85149', fontSize: '0.825rem' }}>
          {errorMsg}
        </div>
      )}

      {/* Pending Action Cards */}
      {pendingActions.length === 0 ? (
        <div
          style={{
            padding: '1.5rem',
            textAlign: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.2)',
            borderRadius: '8px',
            border: '1px dashed var(--border)',
            color: 'var(--text-secondary)',
            fontSize: '0.875rem',
          }}
        >
          No pending action approvals. Voice AI recommendations will appear here automatically.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {pendingActions.map((action) => {
            const style = getStatusStyle(action.status);
            return (
              <div
                key={action.action_id}
                style={{
                  padding: '1rem',
                  borderRadius: '10px',
                  border: `1px solid ${style.border}`,
                  backgroundColor: style.bg,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.65rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                        <code>{action.tool_name}</code>
                      </span>
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '0.15rem 0.4rem', borderRadius: '4px', border: `1px solid ${style.border}`, color: style.color }}>
                        {style.text}
                      </span>
                    </div>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-primary)', marginTop: '0.25rem' }}>
                      <b>Rationale:</b> {action.rationale}
                    </p>
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Proposed by <b>{action.proposed_by}</b> • {new Date(action.created_at).toLocaleTimeString()}
                  </span>
                </div>

                {action.parameters && Object.keys(action.parameters).length > 0 && (
                  <div style={{ fontSize: '0.775rem', color: 'var(--text-secondary)', backgroundColor: '#0d1117', padding: '0.4rem 0.6rem', borderRadius: '6px' }}>
                    <code>Parameters: {JSON.stringify(action.parameters)}</code>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.65rem', marginTop: '0.25rem' }}>
                  <button
                    onClick={() => {
                      setSelectedAction(action);
                      setRejectReason('Unnecessary or conflicting operational priority');
                    }}
                    disabled={isProcessing}
                    style={{
                      padding: '0.45rem 0.85rem',
                      borderRadius: '6px',
                      border: '1px solid #f85149',
                      backgroundColor: 'transparent',
                      color: '#f85149',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    ✕ Reject
                  </button>

                  <button
                    onClick={() => handleApprove(action)}
                    disabled={isProcessing}
                    style={{
                      padding: '0.45rem 1.15rem',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: '#3fb950',
                      color: '#fff',
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      boxShadow: '0 2px 8px rgba(63, 185, 80, 0.4)',
                    }}
                  >
                    ✓ Authorize & Execute
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Historical / Executed Actions Feed */}
      {historicalActions.length > 0 && (
        <div style={{ marginTop: '0.5rem' }}>
          <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '0.65rem' }}>
            Action Execution & Outcome Verification History ({historicalActions.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '220px', overflowY: 'auto' }}>
            {historicalActions.map((action) => {
              const style = getStatusStyle(action.status);
              return (
                <div
                  key={action.action_id}
                  style={{
                    padding: '0.65rem 0.85rem',
                    borderRadius: '8px',
                    border: '1px solid var(--border)',
                    backgroundColor: 'rgba(0, 0, 0, 0.25)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: '0.825rem',
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{action.tool_name}</span>
                    <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>({action.rationale})</span>
                    {action.verified && (
                      <div style={{ fontSize: '0.75rem', color: '#3fb950', marginTop: '0.2rem' }}>
                        ✓ {action.verification_result || 'Outcome Verified'}
                      </div>
                    )}
                    {action.rejection_reason && (
                      <div style={{ fontSize: '0.75rem', color: '#f85149', marginTop: '0.2rem' }}>
                        ✕ Reason: {action.rejection_reason}
                      </div>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      padding: '0.15rem 0.45rem',
                      borderRadius: '4px',
                      backgroundColor: style.bg,
                      border: `1px solid ${style.border}`,
                      color: style.color,
                    }}
                  >
                    {style.text}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Propose Action Modal */}
      {showProposeModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '1rem',
          }}
        >
          <div
            style={{
              backgroundColor: '#161b22',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              padding: '1.75rem',
              width: '100%',
              maxWidth: '480px',
            }}
          >
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>
              Propose Emergency Response Action
            </h2>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              Action will be entered into the approval queue for Commander verification.
            </p>
            <form onSubmit={handleCreateProposal} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.825rem', marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>
                  Tool / Operation Name
                </label>
                <select
                  value={propToolName}
                  onChange={(e) => setPropToolName(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.55rem 0.75rem',
                    backgroundColor: '#0d1117',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    color: '#fff',
                  }}
                >
                  <option value="deploy_mobile_water_purification">deploy_mobile_water_purification</option>
                  <option value="deploy_flood_barriers_and_drainage">deploy_flood_barriers_and_drainage</option>
                  <option value="dispatch_swiftwater_rescue_boats">dispatch_swiftwater_rescue_boats</option>
                  <option value="isolate_contaminated_intake_valves">isolate_contaminated_intake_valves</option>
                  <option value="activate_emergency_shelter_generators">activate_emergency_shelter_generators</option>
                  <option value="broadcast_emergency_evacuation_alert">broadcast_emergency_evacuation_alert</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.825rem', marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>
                  Operational Rationale / Justification
                </label>
                <textarea
                  required
                  rows={3}
                  placeholder="e.g. Flood breach in Sector 4 threatening drinking water station. Immediate barriers required."
                  value={propRationale}
                  onChange={(e) => setPropRationale(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.55rem 0.75rem',
                    backgroundColor: '#0d1117',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    color: '#fff',
                    fontFamily: 'inherit',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setShowProposeModal(false)}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                    backgroundColor: 'transparent',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isProcessing}
                  style={{
                    padding: '0.5rem 1.25rem',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: 'var(--accent-blue)',
                    color: '#fff',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {isProcessing ? 'Submitting...' : 'Queue for Approval'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {selectedAction && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '1rem',
          }}
        >
          <div
            style={{
              backgroundColor: '#161b22',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              padding: '1.75rem',
              width: '100%',
              maxWidth: '440px',
            }}
          >
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem', color: '#f85149' }}>
              Reject Emergency Action
            </h2>
            <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              Action: <code>{selectedAction.tool_name}</code>
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.825rem', marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>
                  Rejection Reason / Strategic Justification
                </label>
                <textarea
                  rows={3}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.55rem 0.75rem',
                    backgroundColor: '#0d1117',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    color: '#fff',
                    fontFamily: 'inherit',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button
                  type="button"
                  onClick={() => setSelectedAction(null)}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                    backgroundColor: 'transparent',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleReject(selectedAction)}
                  disabled={isProcessing}
                  style={{
                    padding: '0.5rem 1.25rem',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: '#f85149',
                    color: '#fff',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Confirm Rejection
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
