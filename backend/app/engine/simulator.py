"""
Tocsin Incident State Simulator
Simulates continuous non-linear state degradation and resolution recovery with realistic jitter.
"""

import asyncio
import logging
import random
import uuid

from app.engine.connection_manager import ws_manager
from app.models.incident import (
    ActionApprovalStatus,
    ActionTaken,
    ApproveActionRequest,
    EventType,
    Hypothesis,
    HypothesisStatus,
    IncidentMetrics,
    IncidentState,
    IncidentStatus,
    Participant,
    ProposeActionRequest,
    ProposedAction,
    RejectActionRequest,
    SeverityLevel,
    Symptom,
    TimelineEntry,
    TriggerEventRequest,
    TriggerResolutionRequest,
    get_utc_now,
)

logger = logging.getLogger("tocsin.engine.simulator")


class IncidentSimulator:
    """
    State machine engine managing live incident state and background simulation loops.
    """

    def __init__(self) -> None:
        self._incidents: dict[str, IncidentState] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._global_lock = asyncio.Lock()

    async def _get_lock(self, incident_id: str) -> asyncio.Lock:
        async with self._global_lock:
            if incident_id not in self._locks:
                self._locks[incident_id] = asyncio.Lock()
            return self._locks[incident_id]

    def _calculate_severity_level(self, score: float) -> SeverityLevel:
        if score >= 80.0:
            return SeverityLevel.CRITICAL
        elif score >= 55.0:
            return SeverityLevel.HIGH
        elif score >= 30.0:
            return SeverityLevel.MEDIUM
        return SeverityLevel.LOW

    async def create_incident(
        self,
        title: str,
        event_type: EventType,
        incident_id: str | None = None,
        initial_symptoms: list[str] | None = None,
    ) -> IncidentState:
        """Initialize and store a new incident state."""
        inc_id = incident_id or f"inc-{uuid.uuid4().hex[:8]}"
        lock = await self._get_lock(inc_id)

        async with lock:
            now = get_utc_now()
            symptoms = []
            if initial_symptoms:
                for idx, sym_text in enumerate(initial_symptoms):
                    symptoms.append(
                        Symptom(
                            id=f"sym-{idx+1}",
                            description=sym_text,
                            severity=SeverityLevel.LOW,
                            reported_at=now,
                        )
                    )

            state = IncidentState(
                incident_id=inc_id,
                title=title,
                event_type=event_type,
                status=IncidentStatus.IDLE,
                severity=SeverityLevel.LOW,
                metrics=IncidentMetrics(
                    severity_score=10.0,
                    water_safety_index=95.0,
                    flood_depth_meters=0.0,
                    affected_population=0,
                    infrastructure_integrity_pct=100.0,
                ),
                symptoms=symptoms,
                timeline=[
                    TimelineEntry(
                        timestamp=now,
                        event_type="INCIDENT_INITIALIZED",
                        description=f"Incident '{title}' created in IDLE state.",
                        actor="SYSTEM",
                    )
                ],
                hypotheses=[
                    Hypothesis(
                        id="hypo-1",
                        title=f"Potential {event_type.value} risk",
                        description="Initial sensor and dispatch assessment pending voice confirmation.",
                        confidence=0.35,
                        status=HypothesisStatus.PROPOSED,
                    )
                ],
                actions_taken=[],
                participants=[
                    Participant(
                        id="part-1",
                        name="System Dispatch",
                        role="Coordinator",
                        language="en",
                    )
                ],
                created_at=now,
                updated_at=now,
            )
            self._incidents[inc_id] = state

        logger.info(f"Incident created: {inc_id} ({title})")
        await ws_manager.broadcast_state(inc_id, state.model_dump())
        return state

    async def get_incident(self, incident_id: str) -> IncidentState | None:
        """Retrieve state for a given incident_id."""
        return self._incidents.get(incident_id)

    async def list_incidents(self) -> list[IncidentState]:
        """List all stored incidents."""
        return list(self._incidents.values())

    async def trigger_event(
        self, incident_id: str, request: TriggerEventRequest
    ) -> IncidentState:
        """
        Trigger a crisis event causing live degradation with light jitter.
        """
        lock = await self._get_lock(incident_id)
        async with lock:
            if incident_id not in self._incidents:
                raise ValueError(f"Incident '{incident_id}' does not exist.")

            state = self._incidents[incident_id]

            # Stop any existing running simulation task
            if incident_id in self._tasks and not self._tasks[incident_id].done():
                self._tasks[incident_id].cancel()

            now = get_utc_now()
            state.status = IncidentStatus.DEGRADING
            state.event_type = request.event_type
            state.updated_at = now

            # Add caller participant if new
            if request.caller_id and not any(p.name == request.caller_id for p in state.participants):
                state.participants.append(
                    Participant(
                        id=f"part-{len(state.participants)+1}",
                        name=request.caller_id,
                        role="Field Reporter",
                        language=request.caller_language or "en",
                        last_active=now,
                    )
                )

            desc = request.description or f"Triggered {request.event_type.value} with intensity {request.intensity}"
            state.timeline.append(
                TimelineEntry(
                    timestamp=now,
                    event_type=f"EVENT_{request.event_type.value}",
                    description=desc,
                    actor=request.caller_id or "SYSTEM",
                    metadata={"intensity": request.intensity},
                )
            )

            # Update hypothesis confidence
            if state.hypotheses:
                state.hypotheses[0].confidence = min(0.95, state.hypotheses[0].confidence + 0.3)
                state.hypotheses[0].status = HypothesisStatus.CONFIRMED

            # Spawn background degradation loop
            task = asyncio.create_task(
                self._run_degradation_loop(incident_id, request.intensity)
            )
            self._tasks[incident_id] = task

        await ws_manager.broadcast_state(incident_id, state.model_dump())
        return state

    async def _run_degradation_loop(self, incident_id: str, intensity: float) -> None:
        """
        Async background loop that progressively degrades incident state with randomized jitter.
        """
        logger.info(f"Starting degradation loop for incident {incident_id} (intensity: {intensity})")
        tick_interval = 0.5  # Run update every 500ms for smooth live updates

        try:
            while True:
                await asyncio.sleep(tick_interval)

                lock = await self._get_lock(incident_id)
                async with lock:
                    if incident_id not in self._incidents:
                        break

                    state = self._incidents[incident_id]
                    if state.status != IncidentStatus.DEGRADING:
                        break

                    # Apply light jitter (random uniform delta between 0.85 and 1.20)
                    jitter = random.uniform(0.85, 1.20)
                    m = state.metrics

                    # Base degradation delta per tick
                    severity_delta = (2.2 * intensity * jitter)
                    m.severity_score = min(100.0, m.severity_score + severity_delta)

                    # Update event-specific metrics
                    if state.event_type == EventType.FLOOD_SURGE:
                        flood_delta = (0.12 * intensity * jitter)
                        m.flood_depth_meters = round(m.flood_depth_meters + flood_delta, 2)
                        m.water_safety_index = max(10.0, round(m.water_safety_index - (1.5 * intensity * jitter), 1))
                        m.affected_population += int(random.randint(1, 4) * intensity)
                        m.infrastructure_integrity_pct = max(20.0, round(m.infrastructure_integrity_pct - (0.8 * jitter), 1))
                    elif state.event_type == EventType.WATER_CONTAMINATION:
                        m.water_safety_index = max(5.0, round(m.water_safety_index - (3.5 * intensity * jitter), 1))
                        m.affected_population += int(random.randint(2, 6) * intensity)
                    elif state.event_type == EventType.STRANDED_GROUP:
                        m.affected_population += int(random.randint(1, 3) * intensity)
                        m.infrastructure_integrity_pct = max(40.0, round(m.infrastructure_integrity_pct - (0.5 * jitter), 1))
                    else:
                        m.infrastructure_integrity_pct = max(10.0, round(m.infrastructure_integrity_pct - (1.2 * intensity * jitter), 1))

                    # Update severity level
                    prev_severity = state.severity
                    state.severity = self._calculate_severity_level(m.severity_score)
                    state.updated_at = get_utc_now()

                    # Add symptom dynamically if threshold crossed
                    if prev_severity != state.severity and state.severity in (SeverityLevel.HIGH, SeverityLevel.CRITICAL):
                        symptom_text = f"Escalation to {state.severity.value}: Severity reached {m.severity_score:.1f}"
                        if not any(s.description == symptom_text for s in state.symptoms):
                            state.symptoms.append(
                                Symptom(
                                    id=f"sym-{len(state.symptoms)+1}",
                                    description=symptom_text,
                                    severity=state.severity,
                                )
                            )

                    dump = state.model_dump()

                # Broadcast tick to WebSockets outside the lock
                await ws_manager.broadcast_state(incident_id, dump)

                # Cap at critical max
                if state.metrics.severity_score >= 100.0:
                    logger.debug(f"Incident {incident_id} reached maximum severity degradation.")

        except asyncio.CancelledError:
            logger.info(f"Degradation loop cancelled for incident {incident_id}")
        except (RuntimeError, ValueError, OSError) as exc:
            logger.error(f"Error in degradation loop for {incident_id}: {exc}")

    async def propose_action(
        self, incident_id: str, request: ProposeActionRequest
    ) -> IncidentState:
        """
        Propose a high-impact emergency action for commander approval.
        """
        lock = await self._get_lock(incident_id)
        async with lock:
            if incident_id not in self._incidents:
                raise ValueError(f"Incident '{incident_id}' does not exist.")

            state = self._incidents[incident_id]
            now = get_utc_now()
            action_id = f"act-prop-{len(state.proposed_actions) + 1}"

            action = ProposedAction(
                action_id=action_id,
                tool_name=request.tool_name,
                parameters=request.parameters,
                rationale=request.rationale,
                proposed_by=request.proposed_by,
                status=ActionApprovalStatus.PENDING_APPROVAL,
                created_at=now,
                recovery_duration_seconds=request.recovery_duration_seconds,
            )
            state.proposed_actions.append(action)
            state.updated_at = now

            state.timeline.append(
                TimelineEntry(
                    timestamp=now,
                    event_type="ACTION_PROPOSED",
                    description=f"Action '{request.tool_name}' proposed by {request.proposed_by}: {request.rationale}",
                    actor=request.proposed_by,
                    metadata={
                        "action_id": action_id,
                        "parameters": request.parameters,
                    },
                )
            )
            dump = state.model_dump()

        await ws_manager.broadcast_state(incident_id, dump)
        return state

    async def approve_action(
        self, incident_id: str, action_id: str, request: ApproveActionRequest
    ) -> IncidentState:
        """
        Approve an emergency action, transitioning it to EXECUTING and starting the recovery simulation loop.
        """
        lock = await self._get_lock(incident_id)
        async with lock:
            if incident_id not in self._incidents:
                raise ValueError(f"Incident '{incident_id}' does not exist.")

            state = self._incidents[incident_id]
            target_action = next(
                (a for a in state.proposed_actions if a.action_id == action_id),
                None,
            )
            if not target_action:
                raise ValueError(f"Proposed action '{action_id}' not found.")

            if target_action.status not in (ActionApprovalStatus.PENDING_APPROVAL, ActionApprovalStatus.REJECTED):
                raise ValueError(f"Action '{action_id}' cannot be approved from status '{target_action.status.value}'.")

            # Cancel existing degradation loop
            if incident_id in self._tasks and not self._tasks[incident_id].done():
                self._tasks[incident_id].cancel()

            now = get_utc_now()
            target_action.status = ActionApprovalStatus.EXECUTING
            target_action.approved_by = request.commander_id
            target_action.approved_at = now
            target_action.executed_at = now
            if request.override_parameters:
                target_action.parameters.update(request.override_parameters)

            # Record in backward-compatible actions_taken list
            taken_action = ActionTaken(
                action_id=target_action.action_id,
                tool_name=target_action.tool_name,
                parameters=target_action.parameters,
                executed_at=now,
                result_summary=f"Approved and executing: {target_action.rationale}",
                verified=False,
            )
            state.actions_taken.append(taken_action)

            state.status = IncidentStatus.RESOLVING
            state.updated_at = now

            state.timeline.append(
                TimelineEntry(
                    timestamp=now,
                    event_type="ACTION_APPROVED",
                    description=f"Action '{target_action.tool_name}' approved by {request.commander_id} and executing.",
                    actor=request.commander_id,
                    metadata={
                        "action_id": action_id,
                        "notes": request.notes,
                    },
                )
            )

            # Spawn recovery loop
            task = asyncio.create_task(
                self._run_recovery_loop(
                    incident_id,
                    target_action.recovery_duration_seconds,
                    target_action.action_id,
                )
            )
            self._tasks[incident_id] = task
            dump = state.model_dump()

        await ws_manager.broadcast_state(incident_id, dump)
        return state

    async def reject_action(
        self, incident_id: str, action_id: str, request: RejectActionRequest
    ) -> IncidentState:
        """
        Reject a proposed emergency action with commander justification.
        """
        lock = await self._get_lock(incident_id)
        async with lock:
            if incident_id not in self._incidents:
                raise ValueError(f"Incident '{incident_id}' does not exist.")

            state = self._incidents[incident_id]
            target_action = next(
                (a for a in state.proposed_actions if a.action_id == action_id),
                None,
            )
            if not target_action:
                raise ValueError(f"Proposed action '{action_id}' not found.")

            now = get_utc_now()
            target_action.status = ActionApprovalStatus.REJECTED
            target_action.rejection_reason = request.reason
            target_action.approved_by = request.commander_id
            state.updated_at = now

            state.timeline.append(
                TimelineEntry(
                    timestamp=now,
                    event_type="ACTION_REJECTED",
                    description=f"Action '{target_action.tool_name}' rejected by {request.commander_id}: {request.reason}",
                    actor=request.commander_id,
                    metadata={"action_id": action_id, "reason": request.reason},
                )
            )
            dump = state.model_dump()

        await ws_manager.broadcast_state(incident_id, dump)
        return state

    async def trigger_resolution(
        self, incident_id: str, request: TriggerResolutionRequest
    ) -> IncidentState:
        """
        Trigger a resolution tool action causing measurable recovery over N seconds with light jitter.
        """
        lock = await self._get_lock(incident_id)
        async with lock:
            if incident_id not in self._incidents:
                raise ValueError(f"Incident '{incident_id}' does not exist.")

            state = self._incidents[incident_id]

            # Cancel existing degradation task
            if incident_id in self._tasks and not self._tasks[incident_id].done():
                self._tasks[incident_id].cancel()

            now = get_utc_now()
            state.status = IncidentStatus.RESOLVING
            state.updated_at = now

            # Record action taken
            action = ActionTaken(
                action_id=f"act-{len(state.actions_taken)+1}",
                tool_name=request.tool_name,
                parameters=request.parameters,
                executed_at=now,
                result_summary=request.action_description,
                verified=False,
            )
            state.actions_taken.append(action)

            # Keep proposed_actions synchronized
            prop_action = ProposedAction(
                action_id=action.action_id,
                tool_name=request.tool_name,
                parameters=request.parameters,
                rationale=request.action_description,
                proposed_by=request.actor,
                status=ActionApprovalStatus.EXECUTING,
                created_at=now,
                approved_by=request.actor,
                approved_at=now,
                executed_at=now,
                recovery_duration_seconds=request.recovery_duration_seconds,
            )
            state.proposed_actions.append(prop_action)

            # Record timeline entry
            state.timeline.append(
                TimelineEntry(
                    timestamp=now,
                    event_type="RESOLUTION_INITIATED",
                    description=f"Action '{request.tool_name}' triggered: {request.action_description}",
                    actor=request.actor,
                    metadata={
                        "recovery_duration_seconds": request.recovery_duration_seconds,
                        "parameters": request.parameters,
                    },
                )
            )

            # Spawn recovery loop
            task = asyncio.create_task(
                self._run_recovery_loop(
                    incident_id,
                    request.recovery_duration_seconds,
                    action.action_id,
                )
            )
            self._tasks[incident_id] = task

        await ws_manager.broadcast_state(incident_id, state.model_dump())
        return state

    async def _run_recovery_loop(
        self, incident_id: str, duration_seconds: float, action_id: str
    ) -> None:
        """
        Progressively recovers incident metrics over N seconds with light jitter until stabilized.
        """
        logger.info(f"Starting recovery loop for incident {incident_id} over {duration_seconds}s")
        tick_interval = 0.5
        total_ticks = max(1, int(duration_seconds / tick_interval))
        current_tick = 0

        try:
            while current_tick < total_ticks:
                await asyncio.sleep(tick_interval)
                current_tick += 1

                lock = await self._get_lock(incident_id)
                async with lock:
                    if incident_id not in self._incidents:
                        break

                    state = self._incidents[incident_id]
                    if state.status != IncidentStatus.RESOLVING:
                        break

                    jitter = random.uniform(0.90, 1.15)
                    m = state.metrics

                    # Target nominal recovery
                    severity_recovery = (m.severity_score - 10.0) / (total_ticks - current_tick + 1) * jitter
                    m.severity_score = max(10.0, round(m.severity_score - severity_recovery, 1))

                    if state.event_type == EventType.FLOOD_SURGE:
                        flood_recovery = m.flood_depth_meters / (total_ticks - current_tick + 1) * jitter
                        m.flood_depth_meters = max(0.0, round(m.flood_depth_meters - flood_recovery, 2))
                        m.water_safety_index = min(98.0, round(m.water_safety_index + (10.0 * jitter), 1))
                        m.infrastructure_integrity_pct = min(100.0, round(m.infrastructure_integrity_pct + (4.0 * jitter), 1))
                    elif state.event_type == EventType.WATER_CONTAMINATION:
                        m.water_safety_index = min(98.0, round(m.water_safety_index + (15.0 * jitter), 1))

                    state.severity = self._calculate_severity_level(m.severity_score)
                    state.updated_at = get_utc_now()
                    dump = state.model_dump()

                await ws_manager.broadcast_state(incident_id, dump)

            # Final stabilization
            lock = await self._get_lock(incident_id)
            async with lock:
                if incident_id in self._incidents:
                    state = self._incidents[incident_id]
                    state.status = IncidentStatus.STABILIZED
                    state.severity = SeverityLevel.LOW
                    state.metrics.severity_score = 10.0
                    if state.event_type == EventType.FLOOD_SURGE:
                        state.metrics.flood_depth_meters = 0.0
                    state.metrics.water_safety_index = 95.0
                    state.metrics.infrastructure_integrity_pct = 98.0

                    # Mark action verified in both collections
                    for act in state.actions_taken:
                        if act.action_id == action_id:
                            act.verified = True

                    for prop_act in state.proposed_actions:
                        if prop_act.action_id == action_id:
                            prop_act.status = ActionApprovalStatus.VERIFIED
                            prop_act.verified = True
                            prop_act.verification_result = "Stabilized nominal metrics confirmed."

                    now = get_utc_now()
                    state.updated_at = now
                    state.timeline.append(
                        TimelineEntry(
                            timestamp=now,
                            event_type="INCIDENT_STABILIZED",
                            description="Incident metrics returned to safe nominal baseline. Verification complete.",
                            actor="SYSTEM",
                        )
                    )
                    final_dump = state.model_dump()

            await ws_manager.broadcast_state(incident_id, final_dump)
            logger.info(f"Incident {incident_id} successfully stabilized.")

        except asyncio.CancelledError:
            logger.info(f"Recovery loop cancelled for incident {incident_id}")
        except (RuntimeError, ValueError, OSError) as exc:
            logger.error(f"Error in recovery loop for {incident_id}: {exc}")

    async def shutdown(self) -> None:
        """Cancel all running background simulation tasks during server shutdown."""
        logger.info("Cancelling all active incident simulation tasks...")
        for task in self._tasks.values():
            if not task.done():
                task.cancel()


# Global simulator instance
simulator = IncidentSimulator()
