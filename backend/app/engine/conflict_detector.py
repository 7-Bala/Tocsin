"""
Tocsin Conflict Detector
Detects conflicts between structured claims about the same entity.

Primary mechanism: structured claim comparison (entity + normalized value).
Heuristics used only as secondary check, clearly labeled.

The detector never auto-resolves conflicts. It only detects and recommends
a verification step for the Incident Commander to assess.
"""

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from app.engine.extraction import normalize_value

# Two opposite readings of the same entity far enough apart in time are a state
# change ("the database is down" ... twenty minutes later ... "the database is
# back up"), not a disagreement. Flagging recovery as a contradiction is the
# cry-wolf failure CLAUDE.md warns destroys trust in the tool.
RECOVERY_WINDOW = timedelta(minutes=10)


def _claim_age_exceeds_recovery_window(existing_timestamp: Any) -> bool:
    """True when the existing claim is old enough to be a superseded state."""
    if not existing_timestamp:
        return False
    ts = existing_timestamp
    if isinstance(ts, str):
        try:
            ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return False
    if not isinstance(ts, datetime):
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - ts) > RECOVERY_WINDOW

logger = logging.getLogger("tocsin.conflict_detector")


# Words that name an ASPECT of a component (a metric, dimension, or reading)
# rather than naming a component itself. "database cpu" and "database connection
# usage" are two readings of one database, not two different databases.
#
# Why this exists: live-observed 2026-09-05 running CLAUDE.md's own canonical
# identity-outage script through the real extraction path. "I suspect the
# authentication database is overloaded" and "Database CPU and connection usage
# look normal and healthy" are a textbook contradiction -- and produced ZERO
# conflicts, because the LLM extracted three unrelated-looking entity keys
# ('authentication database', 'database cpu', 'database connection usage') and
# _entities_match only did equality/substring, so nothing lined up. The seeded
# demo route hid this by writing fixed, already-matching entity names.
#
# Stripping aspect words reduces each entity to its SUBJECT, after which the
# existing substring rule does the right thing:
#   'database cpu'            -> 'database'
#   'authentication database' -> 'authentication database'   ('database' ⊂ it) ✓
# and, importantly, stays conservative where it should:
#   'payment database' vs 'user database' -> unchanged, no containment, NO match,
#   because those are genuinely different systems and flagging them would be the
#   cry-wolf failure this detector is explicitly built to avoid.
_ASPECT_WORDS = frozenset({
    "cpu", "memory", "ram", "disk", "io", "iops", "latency", "usage", "utilisation",
    "utilization", "connection", "connections", "pool", "error", "errors", "rate",
    "throughput", "load", "queue", "traffic", "health", "status", "uptime",
    "availability", "response", "time", "success", "failure", "failures", "count",
    "percentage", "percent", "level", "levels", "metric", "metrics", "telemetry",
    "capacity", "saturation", "consumption",
})


def _subject_of(entity: str) -> str:
    """
    Reduce an entity string to the component it is ABOUT, dropping aspect words.

    Falls back to the full token list when an entity is made up entirely of
    aspect words (e.g. a bare "error rate"), so such an entity still only ever
    matches another bare "error rate" rather than collapsing to empty and
    matching everything.
    """
    tokens = [t for t in re.split(r"[^a-z0-9]+", entity.lower()) if t]
    subject_tokens = [t for t in tokens if t not in _ASPECT_WORDS]
    return " ".join(subject_tokens or tokens)


def _entities_match(ent_a: str, ent_b: str) -> bool:
    """Return True if two entity strings refer to the same component/concept."""
    a = ent_a.lower().strip()
    b = ent_b.lower().strip()
    if not a or not b:
        return False
    if a == b:
        return True
    if a in b or b in a:
        return True

    # Compare the underlying subjects, so differently-phrased readings of one
    # component ("database cpu" vs "authentication database") are recognised as
    # being about the same thing. Value comparison still decides whether they
    # actually contradict -- this only decides whether they are comparable.
    subj_a = _subject_of(a)
    subj_b = _subject_of(b)
    if not subj_a or not subj_b:
        return False
    if subj_a == subj_b:
        return True
    # Require a whole-word containment rather than a raw substring, so "api"
    # doesn't match "rapid" and one-letter/degenerate subjects can't over-match.
    if re.search(rf"(?<!\w){re.escape(subj_a)}(?!\w)", subj_b):
        return True
    if re.search(rf"(?<!\w){re.escape(subj_b)}(?!\w)", subj_a):
        return True
    return False


NUMERIC_DIVERGENCE_THRESHOLD = 0.2


def _values_conflict(val_a: str, val_b: str) -> bool:
    """
    Return True if two claim values for the same entity are semantically opposing.

    Deliberately CONSERVATIVE: two statements about the same entity are usually
    complementary, not contradictory. During a live incident, several people describe
    the same component from different angles ("login api returning 503" and
    "login api at 40% error rate" are the same investigation, not a disagreement).

    A conflict is raised ONLY on positive evidence of contradiction:
      1. Opposing health polarity (healthy vs unhealthy), or
      2. Numeric divergence beyond NUMERIC_DIVERGENCE_THRESHOLD on comparable numbers.

    Anything else returns False. Raising a conflict is an interrupt aimed at the
    Incident Commander; a detector that cries wolf destroys trust in the whole
    evidence record, which is precisely what Tocsin exists to protect.
    """
    # Measurement comparison runs FIRST, before normalization. A number is more
    # specific evidence than the fuzzy healthy/unhealthy bucket, and normalization
    # would destroy it: "40% error rate" and "5% error rate" both collapse to
    # "unhealthy" (both contain "error"), so any polarity-first ordering would call
    # them equal and silently miss a real quantitative disagreement.
    a_measure = _extract_measurement(val_a)
    b_measure = _extract_measurement(val_b)
    # Only comparable when both measure the same thing. Mismatched units fall
    # through to polarity rather than being forced into a numeric comparison.
    if a_measure is not None and b_measure is not None and a_measure[1] == b_measure[1]:
        a_num, b_num = a_measure[0], b_measure[0]
        max_val = max(abs(a_num), abs(b_num))
        if max_val == 0:
            return False
        return abs(a_num - b_num) / max_val > NUMERIC_DIVERGENCE_THRESHOLD

    norm_a = normalize_value(val_a)
    norm_b = normalize_value(val_b)

    # Same normalized value → no conflict
    if norm_a == norm_b:
        return False

    a_healthy = norm_a == "healthy"
    b_healthy = norm_b == "healthy"
    a_unhealthy = norm_a == "unhealthy"
    b_unhealthy = norm_b == "unhealthy"

    # Opposing polarity groups → genuine contradiction
    if (a_healthy and b_unhealthy) or (a_unhealthy and b_healthy):
        return True

    # No positive evidence of contradiction → treat as complementary evidence.
    # (Previously this fell through to "different strings ⇒ conflict", which made
    # every additional detail about an entity look like a disagreement.)
    return False


# A number is treated as a MEASUREMENT only when it stands alone as a quantity —
# optionally followed by a unit. Digits welded into an identifier ("us-east-1", "s3",
# "http/2", "v2") are names, not measurements, and comparing them produces nonsense
# conflicts like "us-east-1 contradicts eu-west-2".
_MEASUREMENT_RE = re.compile(
    r"(?<![\w./-])(\d+(?:\.\d+)?)\s*(%|percent|ms|s\b|sec|secs|seconds|min|mins|minutes|"
    r"rps|qps|gb|mb|kb|connections?|requests?|errors?|users?|nodes?|pods?|replicas?)?"
    r"(?![\w.-]*[a-z])",
    re.IGNORECASE,
)


def _normalize_unit(unit: str | None) -> str | None:
    if not unit:
        return None
    u = unit.strip().lower()
    if u in ("percent", "%"):
        return "%"
    return u.rstrip("s") or u


def _extract_measurement(val: str) -> tuple[float, str | None] | None:
    """
    Extract a comparable measurement as (quantity, unit), or None if the string
    holds no standalone quantity. Returning None means "not numerically
    comparable" — the caller then falls back to polarity comparison rather than
    inventing a comparison.

    The unit is returned, not discarded, because two numbers are only comparable
    when they measure the same thing. Without it, "login api returning 503
    errors" and "login api at a 40% error rate" were read as a 92% divergence
    and reported as a contradiction — comparing an HTTP status code against a
    percentage. That is the exact pair this module's own docstring cites as
    complementary rather than contradictory, and it stayed invisible only
    because the candidate query made the comparison unreachable until 2026-09-05.
    """
    m = _MEASUREMENT_RE.search(val)
    if m:
        try:
            return float(m.group(1)), _normalize_unit(m.group(2))
        except ValueError:
            return None
    return None


def _recommended_action(entity: str, val_a: str, val_b: str, source_a: str, source_b: str) -> str:
    """Generate a specific verification recommendation for a detected conflict."""
    return (
        f"CONFLICT DETECTED on entity '{entity}': "
        f"{source_a} reports '{val_a}' but {source_b} reports '{val_b}'. "
        f"Recommend: Check authoritative monitoring source (dashboard/telemetry) "
        f"to determine ground truth before taking action on this entity."
    )


def detect_conflicts(
    new_entity: str,
    new_value: str,
    new_claim_id: str,
    new_source: str,
    new_speaker: str | None,
    existing_claims: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Compare a new claim against existing claims for the same entity.
    Returns a list of conflict dicts (empty if no conflicts detected).

    This is the primary conflict detection mechanism — structural claim comparison.
    Results are deterministic and traceable.
    """
    conflicts = []

    for existing in existing_claims:
        existing_id = existing.get("id", "")
        existing_entity = existing.get("entity", "")
        existing_value = existing.get("value", "")
        existing_source = existing.get("source", "unknown")
        existing_speaker = existing.get("speaker")

        # Skip only the claim comparing against itself.
        #
        # This used to also skip any pair sharing a source AND a speaker. In a
        # live voice room that is every pair: all three runs of 2026-09-05 wrote
        # every observation as speaker='Operator', source='voice_transcript', so
        # the rule discarded 100% of candidates before they were ever compared.
        # It also encoded a wrong assumption -- an incident commander relaying
        # "engineering suspects the auth DB" and then "SRE says CPU is normal"
        # is exactly one person voicing a contradiction, which is the case this
        # detector most needs to catch.
        if existing_id == new_claim_id:
            continue

        # A later reading that contradicts a much older one is a state change,
        # not a disagreement. Handled by time rather than by speaker, because
        # time is what actually distinguishes the two.
        if _claim_age_exceeds_recovery_window(existing.get("timestamp")):
            continue

        if _entities_match(existing_entity, new_entity) and _values_conflict(existing_value, new_value):
            logger.info(
                f"Conflict detected on entity '{new_entity}' / '{existing_entity}': "
                f"'{existing_value}' (from {existing_source}) vs "
                f"'{new_value}' (from {new_source})"
            )
            conflicts.append({
                "entity": new_entity,
                "claim_a_id": existing_id,
                "claim_b_id": new_claim_id,
                "value_a": existing_value,
                "value_b": new_value,
                "source_a": existing_source,
                "source_b": new_source,
                "speaker_a": existing_speaker,
                "speaker_b": new_speaker,
                "recommended_action": _recommended_action(
                    new_entity, existing_value, new_value, existing_source, new_source
                ),
            })

    return conflicts
