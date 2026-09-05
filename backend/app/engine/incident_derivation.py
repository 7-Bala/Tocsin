"""
Evidence-driven derivation of an incident's headline fields.

Before this module (reported live 2026-09-02): only claims, conflicts, action items
and the timeline responded to what people actually said. The incident's *identity* --
its title, its severity, and its "Possible Causes" list -- was written once at
creation (or by the seeded demo scenario) and never touched again. An operator could
report a completely different failure and the header would still read "Customer Login
and Identity Outage" with a hypothesis nobody had mentioned in minutes.

This module re-derives those three things from the evidence record itself, so the
incident record tracks the conversation instead of the moment it was opened.

Design constraints, per the project's core principle ("organize evidence without
inventing certainty"):

  - Derivation is *descriptive*, never predictive. A derived title restates the
    strongest claim already on the record; it does not diagnose a root cause.
  - Nothing derived is ever presented as human-authored. IncidentState carries
    `title_auto_derived` / `severity_auto_derived` so the UI can label it, and an
    explicit human rename pins the field and stops auto-derivation permanently.
  - Hypotheses come only from utterances a human actually framed as a hypothesis
    (ObservationCategory.HYPOTHESIS). This module never invents a candidate cause
    that nobody proposed.
  - Every function is pure: state in, values out, no I/O. That keeps the whole
    ruleset unit-testable without a database or a live model.
"""

from __future__ import annotations

import hashlib

from app.models.incident import (
    Claim,
    Hypothesis,
    HypothesisStatus,
    IncidentState,
    IncidentStatus,
    Observation,
    ObservationCategory,
    SeverityLevel,
)

# Mirrors the polarity vocabulary used by extraction.py and deriveDynamicTiles.ts so
# an "unhealthy" claim means the same thing to the tiles, the conflict detector and
# the severity calculation. Kept in sync by hand -- there is no shared source of
# truth across the Python and TypeScript runtimes.
UNHEALTHY_VALUES = frozenset({
    "down", "failing", "failed", "error", "unavailable", "offline", "broken",
    "degraded", "unresponsive", "critical", "red", "dead", "crashed",
    # The heuristic extractor now records the state word the speaker actually
    # used rather than a fixed per-pattern constant, so every keyword its health
    # patterns match must be classifiable here or an outage reads as healthy.
    "unreachable", "timeout", "timeouts",
})

# How many distinct unhealthy entities it takes to reach each severity band. These
# are deliberately coarse: severity here is a summary of how much is currently
# reported broken, not a risk model, and pretending to finer granularity than the
# evidence supports would be its own kind of invention.
SEVERITY_THRESHOLDS: list[tuple[int, SeverityLevel]] = [
    (3, SeverityLevel.CRITICAL),
    (2, SeverityLevel.HIGH),
    (1, SeverityLevel.MEDIUM),
]


def _is_unhealthy(value: str) -> bool:
    lowered = (value or "").lower()
    return any(token in lowered for token in UNHEALTHY_VALUES)


# Verb phrases that mark where a subject ends and a predicate begins. The extractor
# is supposed to put only the subject in `entity`, but live-observed 2026-09-02 it
# emitted BOTH "cdn edge network" and "cdn edge network is fully" as separate
# entities, and both "login api" and "login api is returning http 503".
#
# That is not cosmetic. Every function here keys "latest claim per entity" on this
# string, so a recovery report filed under a slightly different spelling never
# supersedes the outage claim -- the entity stays unhealthy forever and severity
# counts one real service twice. It makes the record a ratchet that can only ever
# get worse, which is the opposite of tracking the conversation.
_PREDICATE_MARKERS = (
    " is ", " are ", " was ", " were ", " has ", " have ", " had ",
    " returns ", " returning ", " went ", " goes ", " became ", " keeps ",
)


def _canonical_entity(entity: str) -> str:
    """
    Reduce an extractor-supplied entity to the subject it names, so the same real
    service collapses to one key across turns.

    Deliberately conservative: it only trims at an explicit predicate marker and
    strips trailing filler. It does NOT attempt semantic aliasing -- "kafka broker"
    and "kafka event broker cluster" remain distinct here, because deciding those
    are the same service is a judgement about the world, not string handling, and
    guessing it wrong would silently merge two genuinely different failures.
    """
    text = (entity or "").lower().strip()
    if not text:
        return ""
    for marker in _PREDICATE_MARKERS:
        idx = text.find(marker)
        if idx > 0:
            text = text[:idx]
            break
    return " ".join(text.split()).strip(" ,.;:-")


def _latest_value_by_entity(state: IncidentState) -> dict[str, str]:
    """
    Latest claim value per canonical entity. Shared by severity, status and any
    future rule, so they can never disagree about what is currently broken.
    """
    latest_value: dict[str, str] = {}
    latest_ts: dict[str, str] = {}
    for claim in state.claims or []:
        entity = _canonical_entity(claim.entity)
        if not entity:
            continue
        ts = claim.timestamp or ""
        if entity not in latest_ts or ts > latest_ts[entity]:
            latest_ts[entity] = ts
            latest_value[entity] = claim.value or ""
    return latest_value


def _title_case(text: str) -> str:
    return " ".join(w[:1].upper() + w[1:] if w else w for w in (text or "").split())


def derive_severity(state: IncidentState) -> SeverityLevel:
    """
    Severity as a function of how much is currently reported broken.

    Inputs, in order of weight:
      - distinct entities with an unhealthy latest claim
      - open (unresolved) conflicts, which each add one "unknown" to the pile
      - unresolved risks

    An incident with nothing unhealthy on the record is LOW, not CRITICAL -- the
    previous behavior of staying at whatever it was seeded with meant a resolved
    incident still screamed CRITICAL forever.
    """
    latest_by_entity = _latest_value_by_entity(state)
    unhealthy_entities = sum(1 for v in latest_by_entity.values() if _is_unhealthy(v))
    open_conflicts = sum(
        1 for c in (state.conflicts or []) if getattr(c, "status", None) != "RESOLVED"
    )
    open_risks = sum(
        1 for r in (state.unresolved_risks or []) if getattr(r, "status", None) != "RESOLVED"
    )

    pressure = unhealthy_entities + open_conflicts + open_risks
    for threshold, level in SEVERITY_THRESHOLDS:
        if pressure >= threshold:
            return level
    return SeverityLevel.LOW


def derive_status(state: IncidentState) -> IncidentStatus:
    """
    Where the incident is in its lifecycle, read off the evidence.

    Before this existed, `status` was written only by the seeded demo scenario and
    the metrics simulator -- so an incident could sit on "RESOLVING" while the
    record showed the CDN offline, payments down and Kafka crashed. A status that
    contradicts the evidence under it is worse than no status at all.

    Rules, deliberately coarse and auditable:
      - nothing on the record yet            -> IDLE
      - anything currently reported unhealthy -> DEGRADING
      - nothing unhealthy, but open work left -> RESOLVING
      - nothing unhealthy, nothing open       -> STABILIZED

    CLOSED is never derived. Declaring an incident over is a human judgement, not
    something to infer from an absence of new claims.
    """
    claims = state.claims or []
    if not claims:
        return IncidentStatus.IDLE

    if any(_is_unhealthy(v) for v in _latest_value_by_entity(state).values()):
        return IncidentStatus.DEGRADING

    open_work = (
        sum(1 for c in (state.conflicts or []) if getattr(c, "status", None) != "RESOLVED")
        + sum(1 for r in (state.unresolved_risks or []) if getattr(r, "status", None) != "RESOLVED")
        + sum(
            1
            for a in (state.action_items or [])
            if getattr(a, "status", None) not in ("COMPLETE", "COMPLETED", "VERIFIED")
        )
    )
    return IncidentStatus.RESOLVING if open_work else IncidentStatus.STABILIZED


def derive_title(state: IncidentState) -> str | None:
    """
    A title that restates the strongest thing currently on the record.

    Picks the most recent unhealthy claim (that is what an incident is *about*),
    falling back to the most recent claim of any polarity. Returns None when there
    is no claim to describe, so the caller keeps whatever title already exists
    rather than blanking it.

    Deliberately NOT a diagnosis: "Redis Session Store Down" restates a reported
    claim. It does not assert a cause, which is what `hypotheses` is for.
    """
    # Only the CURRENT claim per entity is eligible. Scanning every claim ever made
    # (the original behavior) meant the headline could keep asserting an outage that
    # a later recovery report had already cleared -- live-observed 2026-09-02, the
    # title read "Cdn Edge Network — Offline In Three Regions" while that entity's
    # latest claim was "healthy". Severity and status already read latest-per-entity;
    # sharing that view is what stops the header contradicting the chips beside it.
    latest_by_entity: dict[str, Claim] = {}
    for claim in state.claims or []:
        if not (claim.entity and claim.value):
            continue
        key = _canonical_entity(claim.entity)
        if not key:
            continue
        current = latest_by_entity.get(key)
        if current is None or (claim.timestamp or "") > (current.timestamp or ""):
            latest_by_entity[key] = claim

    claims = list(latest_by_entity.values())
    if not claims:
        return None

    ordered = sorted(claims, key=lambda c: c.timestamp or "", reverse=True)
    chosen = next((c for c in ordered if _is_unhealthy(c.value)), ordered[0])

    # Canonical form here too, so a title never reads "Login Api Is Returning
    # Http 503 — Error" when the extractor leaks predicate text into the subject.
    entity = _title_case(_canonical_entity(chosen.entity) or chosen.entity.strip())
    value = (chosen.value or "").strip()
    # Keep the headline short: a title is a label, not the claim's full text.
    if len(value) > 42:
        value = value[:39].rstrip() + "..."
    return f"{entity} — {_title_case(value)}" if value else entity


# Both categories are things a human actually said speculatively -- "I suspect X" /
# "it might be Y" -- so both belong in "Possible Causes" as PROPOSED. Restricting to
# HYPOTHESIS alone was too narrow in practice: live-observed 2026-09-02, the
# extractor classified "I suspect the Kafka broker ran out of disk space" as
# ASSUMPTION, so a genuinely-voiced candidate cause never reached the panel.
# Including ASSUMPTION surfaces what people said; it does not invent anything they
# didn't say.
SPECULATIVE_CATEGORIES = frozenset({
    ObservationCategory.HYPOTHESIS,
    ObservationCategory.ASSUMPTION,
})


def derive_hypotheses(state: IncidentState) -> list[Hypothesis]:
    """
    Build the "Possible Causes" list from utterances people actually framed
    speculatively (HYPOTHESIS or ASSUMPTION). Nothing here is generated: if
    nobody proposed a cause, the list is empty, which is the honest answer.

    Confidence carries the extractor's own confidence for that utterance -- so a
    tentative "I suspect..." does not render at the same weight as a strong one.
    Existing hypotheses keep their id (stable across re-derivation, so the UI does
    not churn) and any status a human already set (CONFIRMED / DISPROVEN survives).
    """
    existing_by_key: dict[str, Hypothesis] = {}
    for h in state.hypotheses or []:
        existing_by_key[(h.title or "").lower().strip()] = h

    derived: list[Hypothesis] = []
    seen: set[str] = set()

    hypothesis_obs: list[Observation] = [
        o
        for o in (state.observations or [])
        if o.category in SPECULATIVE_CATEGORIES and (o.content or o.raw_utterance)
    ]
    # Newest first, so the most recent thinking leads the panel.
    hypothesis_obs.sort(key=lambda o: o.timestamp or "", reverse=True)

    for obs in hypothesis_obs:
        text = (obs.content or obs.raw_utterance or "").strip()
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)

        prior = existing_by_key.get(key)
        # Stable id derived from the text, so repeated derivation of the same
        # hypothesis does not produce a new React key on every observation.
        hid = prior.id if prior else f"hyp-{hashlib.sha1(key.encode()).hexdigest()[:10]}"
        derived.append(
            Hypothesis(
                id=hid,
                title=text if len(text) <= 90 else text[:87].rstrip() + "...",
                description=obs.raw_utterance or text,
                confidence=float(obs.confidence if obs.confidence is not None else 0.5),
                # A human verdict on a hypothesis outlives re-derivation.
                status=prior.status if prior else HypothesisStatus.PROPOSED,
                updated_at=obs.timestamp or (prior.updated_at if prior else None) or "",
            )
        )

    return derived


def apply_derivations(state: IncidentState) -> list[str]:
    """
    Re-derive title, severity and hypotheses in place.

    Respects human authorship: a field whose `*_auto_derived` flag is False was set
    by a person and is left alone. Returns a list of human-readable change
    descriptions, so the caller can write timeline entries for what actually moved
    (and write none at all when nothing did).
    """
    changes: list[str] = []

    if state.severity_auto_derived:
        new_severity = derive_severity(state)
        if new_severity != state.severity:
            changes.append(
                f"Severity re-derived from evidence: {state.severity.value} -> {new_severity.value}"
            )
            state.severity = new_severity

    # A human who has explicitly CLOSED an incident must not have it reopened by a
    # late-arriving observation, so a closed incident is left alone regardless of
    # the flag.
    if state.status_auto_derived and state.status != IncidentStatus.CLOSED:
        new_status = derive_status(state)
        if new_status != state.status:
            changes.append(
                f"Status re-derived from evidence: {state.status.value} -> {new_status.value}"
            )
            state.status = new_status

    if state.title_auto_derived:
        new_title = derive_title(state)
        if new_title and new_title != state.title:
            changes.append(f"Title re-derived from evidence: '{state.title}' -> '{new_title}'")
            state.title = new_title

    new_hypotheses = derive_hypotheses(state)
    if [h.title for h in new_hypotheses] != [h.title for h in (state.hypotheses or [])]:
        added = len(new_hypotheses) - len(state.hypotheses or [])
        if added > 0:
            changes.append(f"Possible causes updated from evidence ({added} new)")
        state.hypotheses = new_hypotheses

    return changes
