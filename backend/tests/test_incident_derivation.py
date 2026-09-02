"""
Evidence-driven incident derivation tests (title / severity / hypotheses).

Regression coverage for the live-reported defect of 2026-09-02: only claims,
conflicts and the timeline responded to what people said, while the incident's
title, severity and "Possible Causes" stayed frozen at whatever the incident was
created with. An operator could report an entirely different failure and the header
still read "Customer Login and Identity Outage".

These also lock in the honesty constraints: nothing derived may masquerade as
human-authored, and a human's explicit rename must win permanently.
"""

import pytest

from app.engine.incident_derivation import (
    apply_derivations,
    derive_hypotheses,
    derive_severity,
    derive_title,
)
from app.models.incident import (
    Claim,
    ConflictRecord,
    Hypothesis,
    HypothesisStatus,
    IncidentState,
    Observation,
    ObservationCategory,
    SeverityLevel,
)


def make_claim(entity: str, value: str, ts: str = "2026-09-02T10:00:00Z") -> Claim:
    return Claim(
        id=f"clm-{entity}-{ts}",
        observation_id="obs-1",
        incident_id="inc-1",
        claim_type="system_health",
        entity=entity,
        value=value,
        speaker="Tester",
        source="voice_transcript",
        timestamp=ts,
        confidence=0.9,
    )


def make_obs(content: str, category=ObservationCategory.HYPOTHESIS, ts="2026-09-02T10:00:00Z", conf=0.8) -> Observation:
    return Observation(
        id=f"obs-{abs(hash(content))}",
        incident_id="inc-1",
        raw_utterance=content,
        content=content,
        category=category,
        confidence=conf,
        timestamp=ts,
    )


def make_state(**kw) -> IncidentState:
    base = dict(
        incident_id="inc-1",
        title="Original Title",
        event_type="TECHNICAL_INCIDENT",
    )
    base.update(kw)
    return IncidentState(**base)


# ─── Severity ────────────────────────────────────────────────────────────────

def test_severity_is_low_when_nothing_is_broken():
    """A record with only healthy claims must not stay stuck at a seeded CRITICAL."""
    state = make_state(
        severity=SeverityLevel.CRITICAL,
        claims=[make_claim("login api", "healthy"), make_claim("database", "operational")],
    )
    assert derive_severity(state) == SeverityLevel.LOW


def test_severity_escalates_with_the_number_of_unhealthy_entities():
    one = make_state(claims=[make_claim("a", "down")])
    two = make_state(claims=[make_claim("a", "down"), make_claim("b", "failing")])
    three = make_state(
        claims=[make_claim("a", "down"), make_claim("b", "failing"), make_claim("c", "crashed")]
    )
    assert derive_severity(one) == SeverityLevel.MEDIUM
    assert derive_severity(two) == SeverityLevel.HIGH
    assert derive_severity(three) == SeverityLevel.CRITICAL


def test_severity_counts_only_the_latest_claim_per_entity():
    """A recovered service must stop contributing to severity."""
    state = make_state(claims=[
        make_claim("payments", "down", ts="2026-09-02T10:00:00Z"),
        make_claim("payments", "healthy", ts="2026-09-02T11:00:00Z"),
    ])
    assert derive_severity(state) == SeverityLevel.LOW


def test_open_conflicts_add_to_severity():
    conflict = ConflictRecord(
        id="cf-1",
        incident_id="inc-1",
        entity="database",
        claim_a_id="a",
        claim_b_id="b",
        value_a="healthy",
        value_b="overloaded",
        source_a="voice_transcript",
        source_b="voice_transcript",
    )
    state = make_state(claims=[make_claim("a", "down")], conflicts=[conflict])
    # 1 unhealthy + 1 open conflict = 2 -> HIGH
    assert derive_severity(state) == SeverityLevel.HIGH


# ─── Title ───────────────────────────────────────────────────────────────────

def test_title_restates_the_most_recent_unhealthy_claim():
    state = make_state(claims=[
        make_claim("login api", "healthy", ts="2026-09-02T10:00:00Z"),
        make_claim("redis session store", "down", ts="2026-09-02T11:00:00Z"),
    ])
    assert derive_title(state) == "Redis Session Store — Down"


def test_title_prefers_unhealthy_over_merely_newer():
    """An incident is about what's broken, not about the last thing anyone said."""
    state = make_state(claims=[
        make_claim("payments", "failing", ts="2026-09-02T10:00:00Z"),
        make_claim("dashboard", "healthy", ts="2026-09-02T12:00:00Z"),
    ])
    assert derive_title(state) == "Payments — Failing"


def test_title_returns_none_with_no_claims_so_caller_keeps_existing():
    assert derive_title(make_state()) is None


# ─── Hypotheses ──────────────────────────────────────────────────────────────

def test_hypotheses_come_only_from_utterances_framed_as_hypotheses():
    """Nothing is invented: a REPORT is evidence, not a candidate cause."""
    state = make_state(observations=[
        make_obs("I suspect the auth database is overloaded", ObservationCategory.HYPOTHESIS),
        make_obs("Login API is returning 503s", ObservationCategory.REPORT),
    ])
    hyps = derive_hypotheses(state)
    assert len(hyps) == 1
    assert "auth database is overloaded" in hyps[0].title


def test_assumptions_also_count_as_proposed_causes():
    """
    Live-observed 2026-09-02: the extractor classified "I suspect the Kafka broker
    ran out of disk space" as ASSUMPTION rather than HYPOTHESIS, so filtering on
    HYPOTHESIS alone dropped a genuinely-voiced candidate cause. Both categories are
    things a human actually said speculatively.
    """
    state = make_state(observations=[
        make_obs("I suspect the Kafka broker ran out of disk space", ObservationCategory.ASSUMPTION),
    ])
    hyps = derive_hypotheses(state)
    assert len(hyps) == 1
    assert "Kafka broker" in hyps[0].title
    assert hyps[0].status == HypothesisStatus.PROPOSED


def test_no_hypotheses_when_nobody_proposed_one():
    state = make_state(observations=[make_obs("The API is down", ObservationCategory.REPORT)])
    assert derive_hypotheses(state) == []


def test_hypothesis_keeps_its_id_and_human_verdict_across_rederivation():
    """A commander marking a cause DISPROVEN must not be undone by the next utterance."""
    text = "I suspect the auth database is overloaded"
    state = make_state(observations=[make_obs(text)])
    first = derive_hypotheses(state)
    assert first[0].status == HypothesisStatus.PROPOSED

    first[0].status = HypothesisStatus.DISPROVEN
    state.hypotheses = first
    state.observations.append(make_obs("Another unrelated thought", ts="2026-09-02T11:00:00Z"))

    second = derive_hypotheses(state)
    kept = next(h for h in second if h.title == text)
    assert kept.status == HypothesisStatus.DISPROVEN
    assert kept.id == first[0].id, "id must be stable so the UI does not churn"


# ─── apply_derivations / human authorship ────────────────────────────────────

def test_apply_derivations_updates_everything_and_reports_changes():
    state = make_state(
        title="Customer Login and Identity Outage",
        severity=SeverityLevel.LOW,
        claims=[make_claim("redis session store", "down")],
        observations=[make_obs("I suspect a bad deploy")],
    )
    changes = apply_derivations(state)

    assert state.title == "Redis Session Store — Down"
    assert state.severity == SeverityLevel.MEDIUM
    assert len(state.hypotheses) == 1
    assert any("Title re-derived" in c for c in changes)
    assert any("Severity re-derived" in c for c in changes)


def test_human_rename_pins_the_title_permanently():
    """title_auto_derived=False means evidence never overwrites a commander's name."""
    state = make_state(
        title="Black Friday Checkout Incident",
        title_auto_derived=False,
        claims=[make_claim("redis session store", "down")],
    )
    apply_derivations(state)
    assert state.title == "Black Friday Checkout Incident"


def test_pinned_severity_is_left_alone():
    state = make_state(
        severity=SeverityLevel.CRITICAL,
        severity_auto_derived=False,
        claims=[make_claim("everything", "healthy")],
    )
    apply_derivations(state)
    assert state.severity == SeverityLevel.CRITICAL


def test_apply_derivations_reports_no_changes_when_nothing_moved():
    """Idempotent: a second pass over unchanged evidence must not spam the timeline."""
    state = make_state(claims=[make_claim("redis", "down")], observations=[make_obs("a guess")])
    apply_derivations(state)
    assert apply_derivations(state) == []
